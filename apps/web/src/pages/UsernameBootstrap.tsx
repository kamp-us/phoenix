/**
 * Username bootstrap form — `fate.mutations.user.setUsername`.
 *
 * Mounted by the layout when the signed-in user has `username === null`.
 * Pre-fills the input with the email's local-part. On submit, calls
 * `fate.mutations.user.setUsername(value)` and invokes the supplied refetch hook
 * so the layout can swap to the topbar profile-link state.
 *
 * Client-side validation mirrors the worker-side validator
 * (Pasaport.assertUsername): 3-30 chars, lowercase a-z / 0-9 / `-`, no
 * leading/trailing dash. Server-side validation errors surface inline keyed on
 * the wire **code** (`TOO_SHORT`/`TOO_LONG`/`INVALID_FORMAT`/`TAKEN`/
 * `ALREADY_SET`/…) — not the message string.
 *
 * **Error routing.** The client classifies callSite-vs-boundary purely from the
 * wire `code`, and its `switch` knows only the 6 protocol codes — phoenix codes
 * resolve to `boundary`, so the mutation **throws** instead of returning
 * `{error}`. We therefore handle BOTH the `{error}` return AND the thrown error:
 * read `.code` off either and render the matching message inline. See
 * `.patterns/fate-mutations-client.md`.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/fate/views";
import {codeOf} from "../fate/wire";
import type {MutationErrorCode} from "../lib/mutationErrorCodes";
import "./AuthPage.css";

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The `User` write-back selection for the `setUsername` result. */
const SetUsernameView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
});

/** Map a server wire code to the inline message. */
function messageForCode(code: MutationErrorCode | null): string {
	switch (code) {
		case "TOO_SHORT":
			return "kullanıcı adı en az 3 karakter olmalı";
		case "TOO_LONG":
			return "kullanıcı adı en fazla 30 karakter olabilir";
		case "INVALID_FORMAT":
			return "kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir";
		case "TAKEN":
			return "bu kullanıcı adı alınmış, başka bir tane dene";
		case "ALREADY_SET":
			return "kullanıcı adın zaten ayarlanmış";
		default:
			return "kullanıcı adı ayarlanamadı";
	}
}

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
			// phoenix codes classify as boundary → the mutation throws. Read
			// the code off the thrown error and render inline.
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
