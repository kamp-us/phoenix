/**
 * Username bootstrap form — `fate.mutations.user.setUsername`. The FALLBACK for
 * users who skipped the username field at signup (and pre-existing null-username
 * accounts): mounted by the layout when the signed-in user has `username === null`.
 * Client-side pre-flight runs the single-source rule (`checkUsername`,
 * `worker/features/pasaport/username-rule.ts`) that `assertUsername` enforces
 * server-side; the prefill is derived from the email local-part (`+tag` stripped).
 *
 * Error routing: phoenix codes classify as boundary, so the mutation **throws**
 * for some failures and returns `{error}` for others — we handle BOTH, keying the
 * inline message off the wire `code`. See `.patterns/fate-mutations-client.md`.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {deriveUsernameFromEmail} from "../../worker/features/pasaport/username-rule";
import {codeOf} from "../fate/wire";
import {localRuleMessage, messageForCode} from "./usernameMessages";
import "./AuthPage.css";

/** The `User` write-back selection for the `setUsername` result. */
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

export function UsernameBootstrap({
	email,
	onComplete,
}: {
	email: string;
	onComplete: () => Promise<void> | void;
}) {
	const fate = useFateClient();
	const [value, setValue] = useState(() => deriveUsernameFromEmail(email));
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const local = localRuleMessage(value);
		if (local) {
			setError(local);
			return;
		}
		setError(null);
		setPending(true);
		try {
			const {error: callError} = await fate.mutations.user.setUsername({
				input: {value: value.trim().toLowerCase()},
				view: SetUsernameView,
			});
			if (callError) {
				setError(messageForCode(codeOf(callError)));
				return;
			}
			await onComplete();
		} catch (caught) {
			setError(messageForCode(codeOf(caught as SetUsernameError)));
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
