import {useState} from "react";
import {GraphQLRequestError, gqlFetch} from "../graphql/client";
import "./AuthPage.css";

/**
 * Username bootstrap form. Mounted by the layout when the signed-in user has
 * `username === null`. Pre-fills the input with the email's local-part. On
 * submit, calls `setUsername(value)` and invokes the supplied refetch hook so
 * the layout can swap to the topbar profile link state.
 *
 * Validation mirrors the worker-side validator (Pasaport.assertUsername):
 * 3-30 chars, lowercase a-z / 0-9 / `-`, no leading/trailing dash.
 */
const SET_USERNAME_MUTATION = `
	mutation SetUsername($value: String!) {
		setUsername(value: $value) {
			id
			email
			name
			image
			username
		}
	}
`;

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

interface SetUsernameResponse {
	setUsername: {username: string | null};
}

export function UsernameBootstrap({
	email,
	onComplete,
}: {
	email: string;
	onComplete: () => Promise<void> | void;
}) {
	const localPart = (email.split("@")[0] ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 30);
	const [value, setValue] = useState(localPart);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	function validateLocal(v: string): string | null {
		const trimmed = v.trim().toLowerCase();
		if (trimmed.length < 3) return "kullanıcı adı en az 3 karakter olmalı";
		if (trimmed.length > 30) return "kullanıcı adı en fazla 30 karakter olabilir";
		if (!USERNAME_REGEX.test(trimmed))
			return "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir";
		return null;
	}

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const local = validateLocal(value);
		if (local) {
			setError(local);
			return;
		}
		setError(null);
		setPending(true);
		try {
			await gqlFetch<SetUsernameResponse>(SET_USERNAME_MUTATION, {
				value: value.trim().toLowerCase(),
			});
			await onComplete();
		} catch (err) {
			if (err instanceof GraphQLRequestError) {
				setError(err.errors[0]?.message ?? "kullanıcı adı ayarlanamadı");
			} else {
				setError("kullanıcı adı ayarlanamadı");
			}
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
				<h2 className="kp-auth__title">kullanıcı adını seç</h2>
				<p className="kp-auth__sub">profilin /u/&lt;ad&gt; üzerinden açılır. sonradan değişmez.</p>
				<form className="kp-auth__form" onSubmit={onSubmit}>
					<div className="kp-auth__field">
						<label htmlFor="bootstrap-username">kullanıcı adı</label>
						<input
							id="bootstrap-username"
							name="username"
							type="text"
							autoComplete="off"
							required
							minLength={3}
							maxLength={30}
							value={value}
							onChange={(e) => setValue(e.currentTarget.value)}
							placeholder="elif-kaya"
						/>
					</div>
					{error ? <p className="kp-auth__error">{error}</p> : null}
					<button type="submit" className="kp-auth__submit" disabled={pending}>
						{pending ? "ayarlanıyor…" : "devam et"}
					</button>
				</form>
			</div>
		</div>
	);
}
