import {useEffect, useRef, useState} from "react";
import {useFateClient, view} from "react-fate";
import {Link, Navigate} from "react-router";
import type {User} from "../../worker/features/fate/views";
import {authClient, clearBearerToken, useSession} from "../auth/client";
import {useMe} from "../auth/useMe";
import {actorLabel} from "../components/moderation/actor-identity";
import {CaylakStatusBlock} from "../components/profile/CaylakStatusBlock";
import {DeleteAccountDialog} from "../components/profile/DeleteAccountDialog";
import {ProfileContributionSignal} from "../components/profile/ProfileContributionSignal";
import {ProfileHeader} from "../components/profile/ProfileHeader";
import {profileStandingLabelKey} from "../components/profile/profileStanding";
import {Alert, Button, Input, ToggleGroup} from "../components/ui";
import {PHOENIX_CAYLAK_VISIBILITY} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {type CatalogKey, useT} from "../i18n";
import {type Density, useDensity} from "../lib/density";
import {type ThemeChoice, useTheme} from "../lib/theme";
import {CAYLAK_VISIBILITY_PATH} from "./CaylakVisibilityPage";
import {useProfileStats} from "./useProfileStats";
import "./ProfilePage.css";

const SetDisplayNameView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
});

type SaveState = "idle" | "saving" | "saved" | "error";

// Mirrors the DENSITY_LABELS copy in components/controls/Controls.tsx.
const DENSITY_LABEL_KEYS: Record<Density, CatalogKey> = {
	compact: "profile.density.compact",
	normal: "profile.density.normal",
	spacious: "profile.density.spacious",
};

export function ProfilePage() {
	const session = useSession();
	const {me, status: meStatus, refetch: refetchMe} = useMe();
	const fate = useFateClient();
	const t = useT();
	const u = session.data?.user;
	// Session first, so the reads don't wait on the canonical `me` round-trip (#2188);
	// `username` is immutable once set, so `me` is only the fallback for the brief window
	// where the session row lags a just-written username.
	const readUsername = u?.username ?? me?.username ?? null;
	const statsState = useProfileStats(readUsername);
	// A failed stats (or `me`) fetch must NOT render as `0` — that's the silent
	// honest-empty-state bug (#448). Treat either failure as the strip's error.
	const statsFailed = statsState.status === "error" || meStatus === "error";
	const stats = statsState.status === "ok" ? statsState.stats : null;
	const {choice: themeChoice, setChoice: setThemeChoice} = useTheme();
	const {choice: densityChoice, setChoice: setDensityChoice} = useDensity();
	// The entry point into /caylak-gorunurlugu (#6426): shown only when the feature is live AND
	// the viewer is a yazar, so a dark route and a route the server would refuse are both
	// unreachable from here rather than reachable-then-404.
	const {value: caylakVisibilityOn} = useFlag(PHOENIX_CAYLAK_VISIBILITY, false);
	const [revokingAll, setRevokingAll] = useState(false);
	const [revokeAllError, setRevokeAllError] = useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);

	// Both fall back to the fixed noun, never the email local-part (#2126).
	const username = me?.username ?? null;
	const fallbackActor = t("profile.actor.fallback");
	const name = actorLabel(me?.name ?? u?.name ?? null, username, fallbackActor);
	const handle = username ?? fallbackActor;
	// `null` (no honest tier) renders handle-only rather than a placeholder standing.
	const standingKey = profileStandingLabelKey(me?.tier);
	const standingLabel = standingKey ? t(standingKey) : null;

	const [draftName, setDraftName] = useState(name);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	// The session resolves after first render, so `name` starts as the fallback and the
	// draft has to re-seed when the real name lands. Only re-seed an untouched draft: one
	// the user has edited away from the old server name is left alone.
	const serverName = useRef(name);
	useEffect(() => {
		if (draftName === serverName.current) setDraftName(name);
		serverName.current = name;
	}, [name, draftName]);

	if (session.isPending) return null;
	if (!session.data || !u) return <Navigate to="/auth" replace />;

	const trimmed = draftName.trim();
	const canSave = saveState !== "saving" && trimmed.length > 0 && trimmed !== name;

	// Must go through the worker mutation, NOT `authClient.updateUser`: only the mutation
	// also writes the stamped `user_profile.display_name` a rename needs to reach every
	// byline (#2154). Both `me` and the session cache the name, so both get refetched.
	async function onSaveName() {
		const next = draftName.trim();
		if (!next || next === name) return;
		setSaveState("saving");
		try {
			const {error} = await fate.mutations.user.setDisplayName({
				input: {value: next},
				view: SetDisplayNameView,
			});
			if (error) {
				setSaveState("error");
				return;
			}
		} catch {
			setSaveState("error");
			return;
		}
		await Promise.all([refetchMe(), session.refetch()]);
		setSaveState("saved");
	}

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	// "tüm cihazlardan çık" — the label says ALL devices, so revoke every session
	// (current included) and clear the local bearer like onSignOut; the <Navigate>
	// guard then lands the now-sessionless user on /auth.
	async function onSignOutAll() {
		setRevokingAll(true);
		setRevokeAllError(null);
		const {error} = await authClient.revokeSessions();
		if (error) {
			setRevokeAllError(t("profile.session.revokeError"));
			setRevokingAll(false);
			return;
		}
		clearBearerToken();
		await authClient.signOut();
		clearBearerToken();
	}

	// `account.delete` already tore down every session row server-side; this is only the
	// local cleanup, and the `<Navigate>` guard above lands the sessionless user on auth.
	async function onAccountDeleted() {
		clearBearerToken();
		setDeleteOpen(false);
		await session.refetch();
	}

	return (
		<div className="kp-profile">
			<div className="kp-profile__inner">
				<ProfileHeader
					displayName={name}
					handle={handle}
					standingLabel={standingLabel}
					image={me?.image ?? null}
					stats={stats}
					statsError={statsFailed}
					showKarma
				/>

				{me?.id ? <CaylakStatusBlock profileUserId={me.id} /> : null}

				{/* The owner sees their OWN sandboxed content here: this feed keys on authorId
				    with no sandbox filter. */}
				{readUsername ? <ProfileContributionSignal username={readUsername} /> : null}

				<section className="kp-profile__section">
					<h3>{t("profile.section.account")}</h3>
					<div className="kp-profile__row">
						<span className="label">{t("profile.field.displayName")}</span>
						<span className="value">
							<Input
								className="kp-profile__name-input"
								aria-label={t("profile.field.displayName")}
								value={draftName}
								onChange={(e) => {
									setDraftName(e.target.value);
									setSaveState("idle");
								}}
								error={saveState === "error" ? t("profile.save.error") : undefined}
								disabled={saveState === "saving"}
								fullWidth
							/>
							{saveState === "saved" && (
								<span className="kp-profile__feedback ok">{t("profile.save.saved")}</span>
							)}
						</span>
						<Button
							type="button"
							variant="link"
							size="sm"
							className="edit-btn"
							onClick={onSaveName}
							disabled={!canSave}
							loading={saveState === "saving"}
						>
							{t(saveState === "saving" ? "profile.save.saving" : "profile.save.action")}
						</Button>
					</div>
					<div className="kp-profile__row">
						<span className="label">{t("profile.field.username")}</span>
						<span className="value">@{handle}</span>
						<span className="edit-btn" style={{color: "var(--text-faint)"}}>
							{t("profile.field.username.immutable")}
						</span>
					</div>
					<div className="kp-profile__row readonly">
						<span className="label">{t("profile.field.email")}</span>
						<span className="value">
							{u.email}
							<span className="kp-profile__feedback ok" data-testid="email-change-hint">
								{t("profile.email.soon")}
							</span>
						</span>
						{/* Interim per #75: a secure change-email flow must verify the new address by
						    email before switching, but the worker has no email sender yet (#875).
						    Disabled-with-hint until #875 lands — no silent inert button. */}
						<Button
							type="button"
							variant="link"
							size="sm"
							className="edit-btn"
							data-testid="email-change-btn"
							disabled
							title={t("profile.email.changeUnavailable")}
						>
							{t("profile.email.change")}
						</Button>
					</div>
				</section>

				<section className="kp-profile__section">
					<h3>{t("profile.section.appearance")}</h3>
					<div className="kp-profile__row">
						<span className="label">{t("profile.field.theme")}</span>
						<span className="value">
							<ToggleGroup
								className="kp-toggle-group kp-toggle-group--outline"
								size="sm"
								items={[
									{value: "light", label: t("profile.theme.light")},
									{value: "dark", label: t("profile.theme.dark")},
									{value: "auto", label: t("profile.theme.auto")},
								]}
								value={[themeChoice]}
								onValueChange={([next]) => {
									if (next) setThemeChoice(next as ThemeChoice);
								}}
							/>
						</span>
						<span />
					</div>
					<div className="kp-profile__row">
						<span className="label">{t("profile.field.density")}</span>
						<span className="value">
							<ToggleGroup
								className="kp-toggle-group kp-toggle-group--outline"
								size="sm"
								items={(["compact", "normal", "spacious"] as Density[]).map((density) => ({
									value: density,
									label: t(DENSITY_LABEL_KEYS[density]),
								}))}
								value={[densityChoice]}
								onValueChange={([next]) => {
									if (next) setDensityChoice(next as Density);
								}}
							/>
						</span>
						<span />
					</div>
					{caylakVisibilityOn && me?.tier === "yazar" ? (
						<div className="kp-profile__row">
							<span className="label">{t("profile.field.caylakContributions")}</span>
							<span className="value">{t("profile.caylakContributions.description")}</span>
							<Link
								className="edit-btn"
								to={CAYLAK_VISIBILITY_PATH}
								data-testid="caylak-visibility-link"
							>
								{t("profile.caylakContributions.action")}
							</Link>
						</div>
					) : null}
				</section>

				<section className="kp-profile__section">
					<h3>{t("profile.section.session")}</h3>
					<p>{t("profile.session.description")}</p>
					<div className="kp-profile__danger">
						<Button type="button" variant="secondary" size="sm" onClick={onSignOut}>
							{t("profile.session.signOut")}
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={onSignOutAll}
							disabled={revokingAll}
							loading={revokingAll}
						>
							{t(revokingAll ? "profile.session.signingOutAll" : "profile.session.signOutAll")}
						</Button>
					</div>
					{revokeAllError ? (
						<Alert variant="danger" className="kp-alert--inline kp-profile__error">
							{revokeAllError}
						</Alert>
					) : null}
				</section>

				<section className="kp-profile__section kp-profile__section--last">
					<h3 className="danger">{t("profile.section.danger")}</h3>
					<p>{t("profile.danger.description")}</p>
					<div className="kp-profile__danger">
						<Button
							type="button"
							variant="primary"
							size="sm"
							data-testid="delete-account-btn"
							onClick={() => setDeleteOpen(true)}
						>
							{t("profile.danger.action")}
						</Button>
					</div>
				</section>
			</div>
			<DeleteAccountDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				onConfirmed={onAccountDeleted}
			/>
		</div>
	);
}
