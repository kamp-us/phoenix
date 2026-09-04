/**
 * Username bootstrap form — the fallback the layout mounts when a signed-in user still
 * has `username === null`. The mutation THROWS for some failures and returns `{error}`
 * for others, so both paths are handled below — see `.patterns/fate-mutations-client.md`.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {deriveUsernameFromEmail} from "../../worker/features/pasaport/username-rule";
import {Alert, Button, Form, Input} from "../components/ui";
import {codeOf} from "../fate/wire";
import {useT} from "../i18n";
import {localRuleMessage, messageForCode} from "./usernameMessages";
import "./AuthPage.css";

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
	const t = useT();
	const prefill = deriveUsernameFromEmail(email);
	const [value, setValue] = useState(() => prefill);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	// Resets on any edit, so editing back to the prefill re-arms the confirm step.
	const [confirmed, setConfirmed] = useState(false);

	const normalized = value.trim().toLowerCase();
	const isUneditedEmailPrefill = normalized === prefill.trim().toLowerCase();
	const needsConfirm = isUneditedEmailPrefill && !confirmed;

	async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
		e.preventDefault();
		const local = localRuleMessage(t, value);
		if (local) {
			setError(local);
			return;
		}
		// #1888 AC4: never commit the unedited email-derived prefill without a
		// deliberate confirm — a permanent handle must be a choice, not a default.
		if (needsConfirm) {
			setConfirmed(true);
			setError(null);
			return;
		}
		setError(null);
		setPending(true);
		try {
			const {error: callError} = await fate.mutations.user.setUsername({
				input: {value: normalized},
				view: SetUsernameView,
			});
			if (callError) {
				setError(messageForCode(t, codeOf(callError)));
				return;
			}
			await onComplete();
		} catch (caught) {
			setError(messageForCode(t, codeOf(caught as SetUsernameError)));
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
				<h2 className="kp-auth__title">{t("auth.bootstrap.title")}</h2>
				<p className="kp-auth__sub">{t("auth.field.username.hint")}</p>
				<Form className="kp-auth__form" onSubmit={onSubmit}>
					<Input
						className="kp-auth__field"
						id="bootstrap-username"
						name="username"
						type="text"
						label={t("auth.field.username.label")}
						aria-label={t("auth.field.username.label")}
						hint={needsConfirm ? t("auth.bootstrap.confirmHint") : undefined}
						autoComplete="off"
						required
						minLength={3}
						maxLength={30}
						value={value}
						onChange={(e) => {
							setValue(e.currentTarget.value);
							setConfirmed(false);
						}}
						fullWidth
						variant="fill"
						placeholder="elif-kaya"
					/>
					{error ? (
						<Alert variant="danger" className="kp-alert--inline kp-auth__error">
							{error}
						</Alert>
					) : null}
					<Button
						type="submit"
						variant="primary"
						block
						className="kp-auth__submit"
						disabled={pending}
						loading={pending}
					>
						{pending
							? t("auth.username.saving")
							: needsConfirm
								? t("auth.bootstrap.confirmSubmit")
								: t("auth.bootstrap.submit")}
					</Button>
				</Form>
			</div>
		</div>
	);
}
