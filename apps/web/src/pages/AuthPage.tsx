import {useState} from "react";
import {authClient} from "../auth/client";
import "./AuthPage.css";

type Mode = "sign-in" | "sign-up";

export function AuthPage() {
	const [mode, setMode] = useState<Mode>("sign-in");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const isSignIn = mode === "sign-in";

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const data = new FormData(e.currentTarget);
		setError(null);
		setPending(true);
		try {
			if (isSignIn) {
				const result = await authClient.signIn.email({
					email: String(data.get("email") ?? ""),
					password: String(data.get("password") ?? ""),
				});
				if (result.error) setError(result.error.message ?? "giriş başarısız");
			} else {
				const result = await authClient.signUp.email({
					name: String(data.get("name") ?? ""),
					email: String(data.get("email") ?? ""),
					password: String(data.get("password") ?? ""),
				});
				if (result.error) setError(result.error.message ?? "kayıt başarısız");
			}
			// The Layout's effect watches `session.data` and navigates off /auth
			// to the `?returnTo=…` URL (or `/` when missing) once the session
			// lands; AuthPage itself is intentionally stateless about the
			// redirect.
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
					{isSignIn ? "kaldığın yerden devam et." : "birkaç yüz kişiden biri ol."}
				</p>
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
