import {useState} from "react";
import {authClient} from "./client";

export function SignUpForm() {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);
		setPending(true);
		try {
			const result = await authClient.signUp.email({name, email, password});
			if (result.error) setError(result.error.message ?? "sign-up failed");
		} finally {
			setPending(false);
		}
	}

	return (
		<form onSubmit={onSubmit} className="auth-form">
			<h2>sign up</h2>
			<label>
				<span>name</span>
				<input
					type="text"
					autoComplete="name"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
			</label>
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
					autoComplete="new-password"
					required
					minLength={8}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
			</label>
			<button type="submit" disabled={pending}>
				{pending ? "creating…" : "create account"}
			</button>
			{error && <p data-error>{error}</p>}
		</form>
	);
}
