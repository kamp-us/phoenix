import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {authClient} from "../auth/client";
import {codeOf} from "../fate/wire";
import {validateEmail, validateName, validatePassword, validateSignIn} from "./authValidation";
import {beginUsernameResolution, endUsernameResolution} from "./signupUsernameGate";
import {localRuleMessage, messageForCode} from "./usernameMessages";
import "./AuthPage.css";

type Mode = "sign-in" | "sign-up";

/** The `User` write-back selection for the post-signup `setUsername` call. */
const SetUsernameView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
});

interface SetUsernameError {
	readonly code?: unknown;
}

export function AuthPage() {
	const [mode, setMode] = useState<Mode>("sign-in");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// #1888: the chosen handle whose post-signup `setUsername` failed. Non-null ⇒
	// the account exists but the handle didn't land — render the blocking retry
	// surface and keep the redirect gate latched until it resolves or is abandoned.
	const [stuckUsername, setStuckUsername] = useState<string | null>(null);
	const isSignIn = mode === "sign-in";
	const fate = useFateClient();

	// Route the chosen handle through the `setUsername` mutation (`username` is
	// better-auth `input: false`, so it can't ride `signUp.email`). Returns the
	// inline error message on failure, or `null` once the handle lands. Handles
	// BOTH fate shapes: a returned `{error}` and a thrown boundary error.
	async function setUsernameOrFail(handle: string): Promise<string | null> {
		try {
			const {error: callError} = await fate.mutations.user.setUsername({
				input: {value: handle},
				view: SetUsernameView,
			});
			if (callError) return messageForCode(codeOf(callError));
			return null;
		} catch (caught) {
			return messageForCode(codeOf(caught as SetUsernameError));
		}
	}

	async function retryStuckUsername() {
		if (stuckUsername == null) return;
		setError(null);
		setPending(true);
		try {
			const message = await setUsernameOrFail(stuckUsername);
			if (message) {
				setError(message);
				return;
			}
			// Landed — clear the stuck state and release the gate so the Layout
			// redirect carries the user into the app with the chosen handle set.
			setStuckUsername(null);
			endUsernameResolution();
		} finally {
			setPending(false);
		}
	}

	// The deliberate escape hatch: give up on the chosen handle and fall through to
	// the null-username bootstrap. Releasing the gate lets the redirect proceed;
	// the account still has no handle, so `UsernameBootstrap` mounts — but only
	// after an explicit choice, never as a silent default.
	function abandonStuckUsername() {
		setStuckUsername(null);
		setError(null);
		endUsernameResolution();
	}

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const data = new FormData(e.currentTarget);
		setError(null);

		if (isSignIn) {
			const email = String(data.get("email") ?? "");
			const password = String(data.get("password") ?? "");
			// Form is `noValidate` — drive the required/format checks in Turkish through
			// the `kp-auth__error` surface instead of the browser's locale-default bubble.
			const fieldError = validateSignIn(email, password);
			if (fieldError) {
				setError(fieldError);
				return;
			}
			setPending(true);
			try {
				const result = await authClient.signIn.email({email, password});
				if (result.error) setError(result.error.message ?? "giriş başarısız");
			} finally {
				setPending(false);
			}
			return;
		}

		const name = String(data.get("name") ?? "");
		const email = String(data.get("email") ?? "");
		const password = String(data.get("password") ?? "");
		// Username is optional at signup; when present it must pass the same rule the
		// server enforces (`assertUsername`). Pre-flight here so a bad handle never
		// creates the account, then surfaces as a confusing post-signup failure.
		// Normalize identically to the bootstrap fallback so the two never diverge.
		const username = String(data.get("username") ?? "")
			.trim()
			.toLowerCase();

		// Form is `noValidate` — validate the required/format constraints in Turkish
		// through the `kp-auth__error` surface (no browser-locale bubble), in visual
		// field order: görünen ad → e-posta → kullanıcı adı → parola.
		const fieldError =
			validateName(name) ??
			validateEmail(email) ??
			(username ? localRuleMessage(username) : null) ??
			validatePassword(password, "sign-up");
		if (fieldError) {
			setError(fieldError);
			return;
		}

		setPending(true);
		try {
			const result = await authClient.signUp.email({name, email, password});
			if (result.error) {
				setError(result.error.message ?? "kayıt başarısız");
				return;
			}

			// `username` is better-auth `input: false`, so it can't ride `signUp.email`;
			// route the chosen handle through the same `setUsername` mutation the
			// bootstrap fallback uses (cookie-authenticated by the session signup just
			// established). A blank field leaves `username === null` so the layout's
			// bootstrap gate fires as the fallback (AC3).
			if (username) {
				// Latch the redirect gate BEFORE the async setUsername: `signUp.email`
				// already established the session, so the Layout redirect would fire the
				// instant this handler yields. Holding it keeps AuthPage mounted so a
				// failure is visible + retryable here — never buried under the redirect,
				// which is the #1888 silent-drop.
				beginUsernameResolution();
				const message = await setUsernameOrFail(username);
				if (message) {
					// The handle didn't land. Do NOT release the gate: park in the retry
					// surface so the chosen handle is never silently dropped into the
					// email-prefill bootstrap.
					setStuckUsername(username);
					setError(message);
					return;
				}
				// Landed — release the gate so the Layout redirect proceeds.
				endUsernameResolution();
			}
			// Redirect is intentionally not handled here: the Layout's effect
			// watches `session.data` and navigates off /auth to `?returnTo=…`
			// (or `/`) once the session lands (and the gate is clear).
		} finally {
			setPending(false);
		}
	}

	// #1888: the account exists but the chosen handle failed to set. Block on a
	// visible, retryable surface — never fall through to the redirect + email
	// prefill, which is how the chosen handle got silently dropped before.
	if (stuckUsername != null) {
		return (
			<div className="kp-auth">
				<div className="kp-auth__card">
					<div className="kp-auth__brand">
						kamp<span className="dot">.</span>us
					</div>
					<h2 className="kp-auth__title">kullanıcı adı ayarlanamadı</h2>
					<p className="kp-auth__sub">
						hesabın açıldı, ama seçtiğin <strong>{stuckUsername}</strong> adı ayarlanamadı.
						kullanıcı adı sonradan değişmez, o yüzden devam etmeden önce tekrar dene.
					</p>
					{error ? <p className="kp-auth__error">{error}</p> : null}
					<div className="kp-auth__form">
						<button
							type="button"
							className="kp-auth__submit"
							disabled={pending}
							onClick={retryStuckUsername}
						>
							{pending ? "ayarlanıyor…" : "tekrar dene"}
						</button>
					</div>
					<div className="kp-auth__alt">
						<button type="button" onClick={abandonStuckUsername} disabled={pending}>
							bu adı bırak, sonra seçerim
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="kp-auth">
			<div className="kp-auth__card">
				<div className="kp-auth__brand">
					kamp<span className="dot">.</span>us
				</div>
				<h2 className="kp-auth__title">{isSignIn ? "giriş yap" : "kayıt ol"}</h2>
				<p className="kp-auth__sub">
					{isSignIn ? "kaldığın yerden devam et." : "kapı açık, söz hakkı kazanılır."}
				</p>
				{!isSignIn ? (
					<p className="kp-auth__rite">
						hesap açmak herkese serbest. ilk yazdıkların çaylak olarak divanda incelenir; katkı
						verdikçe bir yazarın kefilliğiyle yazar olursun — o zaman yazdıkların doğrudan yayına
						girer.
					</p>
				) : null}
				<form className="kp-auth__form" onSubmit={onSubmit} noValidate>
					{!isSignIn ? (
						<div className="kp-auth__field">
							<label htmlFor="auth-name">görünen ad</label>
							<input
								id="auth-name"
								name="name"
								type="text"
								autoComplete="name"
								required
								placeholder="elif kaya"
							/>
						</div>
					) : null}
					<div className="kp-auth__field">
						<label htmlFor="auth-email">e-posta</label>
						<input
							id="auth-email"
							name="email"
							type="email"
							autoComplete="email"
							required
							placeholder="elif@kamp.us"
						/>
					</div>
					{!isSignIn ? (
						<div className="kp-auth__field">
							<label htmlFor="auth-username">
								kullanıcı adı <span className="kp-auth__optional">(isteğe bağlı)</span>
							</label>
							<input
								id="auth-username"
								name="username"
								type="text"
								autoComplete="off"
								minLength={3}
								maxLength={30}
								placeholder="elif-kaya"
							/>
							<p className="kp-auth__hint">
								profilin /u/&lt;ad&gt; üzerinden açılır. sonradan değişmez.
							</p>
						</div>
					) : null}
					<div className="kp-auth__field">
						<label htmlFor="auth-pw">parola</label>
						<input
							id="auth-pw"
							name="password"
							type="password"
							autoComplete={isSignIn ? "current-password" : "new-password"}
							required
							minLength={8}
							placeholder={isSignIn ? "••••••••" : "en az 8 karakter"}
						/>
					</div>
					{error ? <p className="kp-auth__error">{error}</p> : null}
					<button type="submit" className="kp-auth__submit" disabled={pending}>
						{pending ? (isSignIn ? "giriliyor…" : "açılıyor…") : isSignIn ? "devam et" : "hesap aç"}
					</button>
				</form>
				<div className="kp-auth__alt">
					{isSignIn ? "hesabın yok mu? " : "zaten hesabın var mı? "}
					<button type="button" onClick={() => setMode(isSignIn ? "sign-up" : "sign-in")}>
						{isSignIn ? "kayıt ol" : "giriş yap"}
					</button>
				</div>
			</div>
		</div>
	);
}
