import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {authClient} from "../auth/client";
import {codeOf} from "../fate/wire";
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
	const isSignIn = mode === "sign-in";
	const fate = useFateClient();

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const data = new FormData(e.currentTarget);
		setError(null);

		if (isSignIn) {
			setPending(true);
			try {
				const result = await authClient.signIn.email({
					email: String(data.get("email") ?? ""),
					password: String(data.get("password") ?? ""),
				});
				if (result.error) setError(result.error.message ?? "giriş başarısız");
			} finally {
				setPending(false);
			}
			return;
		}

		// Username is optional at signup; when present it must pass the same rule the
		// server enforces (`assertUsername`). Pre-flight here so a bad handle never
		// creates the account, then surfaces as a confusing post-signup failure.
		const username = String(data.get("username") ?? "").trim();
		if (username) {
			const ruleError = localRuleMessage(username);
			if (ruleError) {
				setError(ruleError);
				return;
			}
		}

		setPending(true);
		try {
			const result = await authClient.signUp.email({
				name: String(data.get("name") ?? ""),
				email: String(data.get("email") ?? ""),
				password: String(data.get("password") ?? ""),
			});
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
				try {
					const {error: callError} = await fate.mutations.user.setUsername({
						input: {value: username},
						view: SetUsernameView,
					});
					if (callError) {
						setError(messageForCode(codeOf(callError)));
						return;
					}
				} catch (caught) {
					setError(messageForCode(codeOf(caught as SetUsernameError)));
					return;
				}
			}
			// Redirect is intentionally not handled here: the Layout's effect
			// watches `session.data` and navigates off /auth to `?returnTo=…`
			// (or `/`) once the session lands.
		} finally {
			setPending(false);
		}
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
				<form className="kp-auth__form" onSubmit={onSubmit}>
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
