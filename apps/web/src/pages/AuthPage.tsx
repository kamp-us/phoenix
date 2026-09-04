import {Alert, Button, Form, Input} from "@kampus/design";
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {User} from "../../worker/features/fate/views";
import {authClient} from "../auth/client";
import {codeOf} from "../fate/wire";
import {useT} from "../i18n";
import {validateEmail, validateName, validatePassword, validateSignIn} from "./authValidation";
import {beginUsernameResolution, endUsernameResolution} from "./signupUsernameGate";
import {localRuleMessage, messageForCode} from "./usernameMessages";
import "./AuthPage.css";

type Mode = "sign-in" | "sign-up";

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
	// Non-null ⇒ the account exists but the chosen handle didn't land; the redirect gate
	// stays latched until it resolves or is abandoned (#1888).
	const [stuckUsername, setStuckUsername] = useState<string | null>(null);
	const isSignIn = mode === "sign-in";
	const fate = useFateClient();
	const t = useT();

	// A separate mutation because `username` is better-auth `input: false`, so it can't
	// ride `signUp.email`. Both fate failure shapes reach here: a returned `{error}` and
	// a thrown boundary error.
	async function setUsernameOrFail(handle: string): Promise<string | null> {
		try {
			const {error: callError} = await fate.mutations.user.setUsername({
				input: {value: handle},
				view: SetUsernameView,
			});
			if (callError) return messageForCode(t, codeOf(callError));
			return null;
		} catch (caught) {
			return messageForCode(t, codeOf(caught as SetUsernameError));
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
			setStuckUsername(null);
			endUsernameResolution();
		} finally {
			setPending(false);
		}
	}

	// The escape hatch: drop the chosen handle and fall through to the null-username
	// bootstrap — reachable only by explicit choice, never as a silent default.
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
			// The form is `noValidate`, so these hand-rolled checks are the only ones that
			// run — the browser's bubble would speak the wrong language.
			const fieldError = validateSignIn(email, password);
			if (fieldError) {
				setError(t(fieldError));
				return;
			}
			setPending(true);
			try {
				const result = await authClient.signIn.email({email, password});
				if (result.error) setError(result.error.message ?? t("auth.signIn.failed"));
			} finally {
				setPending(false);
			}
			return;
		}

		const name = String(data.get("name") ?? "");
		const email = String(data.get("email") ?? "");
		const password = String(data.get("password") ?? "");
		// Normalize identically to the bootstrap fallback, or the two paths diverge.
		const username = String(data.get("username") ?? "")
			.trim()
			.toLowerCase();

		// Checked in visual field order. The handle is pre-flighted against the same rule the
		// server enforces, so a bad one never creates the account and then fails confusingly
		// after signup. `localRuleMessage` renders through the catalog itself, so it hands back
		// a message rather than a key.
		const beforeUsername = validateName(name) ?? validateEmail(email);
		if (beforeUsername) {
			setError(t(beforeUsername));
			return;
		}
		const usernameMessage = username ? localRuleMessage(t, username) : null;
		if (usernameMessage) {
			setError(usernameMessage);
			return;
		}
		const passwordError = validatePassword(password, "sign-up");
		if (passwordError) {
			setError(t(passwordError));
			return;
		}

		setPending(true);
		try {
			const result = await authClient.signUp.email({name, email, password});
			if (result.error) {
				setError(result.error.message ?? t("auth.signUp.failed"));
				return;
			}

			if (username) {
				// Latch the gate BEFORE the await: `signUp.email` already established the
				// session, so the Layout redirect fires the instant this handler yields and
				// a setUsername failure would be buried under it (#1888).
				beginUsernameResolution();
				const message = await setUsernameOrFail(username);
				if (message) {
					// Deliberately no `endUsernameResolution()` here: park in the retry surface
					// rather than dropping the handle into the email-prefill bootstrap.
					setStuckUsername(username);
					setError(message);
					return;
				}
				endUsernameResolution();
			}
			// No redirect here by design: the Layout's effect watches `session.data` and
			// navigates off /auth once the session lands and the gate is clear.
		} finally {
			setPending(false);
		}
	}

	if (stuckUsername != null) {
		return (
			<div className="kp-auth">
				<div className="kp-auth__card">
					<div className="kp-auth__brand">
						kamp<span className="dot">.</span>us
					</div>
					<h2 className="kp-auth__title">{t("auth.stuck.title")}</h2>
					<p className="kp-auth__sub">
						{t("auth.stuck.subBefore")} <strong>{stuckUsername}</strong> {t("auth.stuck.subAfter")}
					</p>
					{error ? (
						<Alert variant="danger" className="kp-alert--inline kp-auth__error">
							{error}
						</Alert>
					) : null}
					<div className="kp-auth__form">
						<Button
							type="button"
							variant="primary"
							block
							className="kp-auth__submit"
							disabled={pending}
							loading={pending}
							onClick={retryStuckUsername}
						>
							{pending ? t("auth.username.saving") : t("auth.stuck.retry")}
						</Button>
					</div>
					<div className="kp-auth__alt">
						<Button type="button" variant="link" onClick={abandonStuckUsername} disabled={pending}>
							{t("auth.stuck.abandon")}
						</Button>
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
				<h2 className="kp-auth__title">
					{isSignIn ? t("auth.signIn.title") : t("auth.signUp.title")}
				</h2>
				<p className="kp-auth__sub">{isSignIn ? t("auth.signIn.sub") : t("auth.signUp.sub")}</p>
				{!isSignIn ? (
					<p className="kp-auth__rite">
						{t("auth.signUp.rite", {divanNoun: t("auth.brand.divan")})}
					</p>
				) : null}
				<Form className="kp-auth__form" onSubmit={onSubmit} noValidate>
					{!isSignIn ? (
						<Input
							className="kp-auth__field"
							id="auth-name"
							name="name"
							type="text"
							label={t("auth.field.name.label")}
							aria-label={t("auth.field.name.label")}
							autoComplete="name"
							required
							fullWidth
							variant="fill"
							placeholder="elif kaya"
						/>
					) : null}
					<Input
						className="kp-auth__field"
						id="auth-email"
						name="email"
						type="email"
						label={t("auth.field.email.label")}
						aria-label={t("auth.field.email.label")}
						autoComplete="email"
						required
						fullWidth
						variant="fill"
						placeholder="elif@kamp.us"
					/>
					{!isSignIn ? (
						<Input
							className="kp-auth__field"
							id="auth-username"
							name="username"
							type="text"
							label={
								<>
									{t("auth.field.username.label")}{" "}
									<span className="kp-auth__optional">{t("auth.field.username.optional")}</span>
								</>
							}
							hint={t("auth.field.username.hint")}
							autoComplete="off"
							minLength={3}
							maxLength={30}
							fullWidth
							variant="fill"
							placeholder="elif-kaya"
						/>
					) : null}
					<Input
						className="kp-auth__field"
						id="auth-pw"
						name="password"
						type="password"
						label={t("auth.field.password.label")}
						aria-label={t("auth.field.password.label")}
						autoComplete={isSignIn ? "current-password" : "new-password"}
						required
						minLength={8}
						fullWidth
						variant="fill"
						capsLockLabel={t("auth.field.password.capsLock")}
						showPasswordLabel={t("auth.field.password.show")}
						hidePasswordLabel={t("auth.field.password.hide")}
						placeholder={isSignIn ? "••••••••" : t("auth.field.password.placeholder")}
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
							? isSignIn
								? t("auth.signIn.pending")
								: t("auth.signUp.pending")
							: isSignIn
								? t("auth.signIn.submit")
								: t("auth.signUp.submit")}
					</Button>
				</Form>
				<div className="kp-auth__alt">
					{isSignIn ? t("auth.signIn.altPrompt") : t("auth.signUp.altPrompt")}
					<Button
						type="button"
						variant="link"
						onClick={() => setMode(isSignIn ? "sign-up" : "sign-in")}
					>
						{isSignIn ? t("auth.signUp.title") : t("auth.signIn.title")}
					</Button>
				</div>
			</div>
		</div>
	);
}
