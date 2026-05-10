import {useState} from "react";
import {Button} from "../components/ui/Button";
import {Field, Form, Input, Label} from "../components/ui/Form";
import {authClient} from "./client";

export function SignUpForm() {
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const data = new FormData(e.currentTarget);
		setError(null);
		setPending(true);
		try {
			const result = await authClient.signUp.email({
				name: String(data.get("name") ?? ""),
				email: String(data.get("email") ?? ""),
				password: String(data.get("password") ?? ""),
			});
			if (result.error) setError(result.error.message ?? "kayıt başarısız");
		} finally {
			setPending(false);
		}
	}

	return (
		<Form onSubmit={onSubmit}>
			<Field name="name">
				<Label>isim</Label>
				<Input name="name" type="text" autoComplete="name" required />
			</Field>
			<Field name="email">
				<Label>e-posta</Label>
				<Input name="email" type="email" autoComplete="email" required />
			</Field>
			<Field name="password">
				<Label>şifre</Label>
				<Input
					name="password"
					type="password"
					autoComplete="new-password"
					required
					minLength={8}
				/>
			</Field>
			{error ? (
				<p style={{color: "var(--danger)", font: "var(--t-meta)", margin: 0}}>{error}</p>
			) : null}
			<div style={{display: "flex", justifyContent: "flex-end"}}>
				<Button variant="primary" type="submit" disabled={pending}>
					{pending ? "oluşturuluyor…" : "hesap oluştur"}
				</Button>
			</div>
		</Form>
	);
}
