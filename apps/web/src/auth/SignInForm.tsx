import {useState} from "react";
import {authClient} from "./client";

export function SignInForm() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setPending(true);
		try {
			const result = await authClient.signIn.email({email, password});
			if (result.error) setError(result.error.message ?? "sign-in failed");
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="auth-form">
			<h2>sign in</h2>
			<label>
				<span>email</span>
				<input
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
			</label>
			<label>
				<span>password</span>
				<input
					type="password"
					autoComplete="current-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
			</label>
			<button type="submit" disabled={pending}>
				{pending ? "signing in…" : "sign in"}
			</button>
			{error && <p data-error>{error}</p>}
		</form>
	);
}
