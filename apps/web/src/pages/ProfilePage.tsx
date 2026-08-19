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
import {profileStandingLabel} from "../components/profile/profileStanding";
import {Alert, Button, Input, ToggleGroup} from "../components/ui";
import {PHOENIX_CAYLAK_VISIBILITY} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {type Density, useDensity} from "../lib/density";
import {type ThemeChoice, useTheme} from "../lib/theme";
import {CAYLAK_VISIBILITY_PATH} from "./CaylakVisibilityPage";
import {useProfileStats} from "./useProfileStats";
import "./ProfilePage.css";

/** The `User` write-back selection for the `setDisplayName` result. */
const SetDisplayNameView = view<User>()({
	id: true,
	email: true,
	name: true,
	image: true,
	username: true,
});

type SaveState = "idle" | "saving" | "saved" | "error";

// Mirrors the DENSITY_LABELS Turkish copy in components/controls/Controls.tsx.
const DENSITY_LABELS: Record<Density, string> = {
	compact: "sıkı",
	normal: "normal",
	spacious: "ferah",
};

export function ProfilePage() {
	const session = useSession();
	const {me, status: meStatus, refetch: refetchMe} = useMe();
	const fate = useFateClient();
	const u = session.data?.user;
	// The username the profile READS (counts + Katkıların contributions) key on. Prefer
	// the settled session identity — available the instant `FateProvider` commits — so
	// the read fires WITHOUT the extra canonical-`me` round-trip that used to gate it,
	// the third serial hop that made Katkıların land ~1.8s late (#2188). `username` is
	// server-managed + immutable once set (`better-auth-live.ts`), so the session value
	// equals `me.username`; fall back to `me` only for the brief post-`setUsername`
	// window where the session row still lags the just-written username (see `useMe`).
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

	// Route the identity mirror through the shared actor-label rule (#2126): the
	// display name, falling back to the chosen @username, never the email-derived
	// local-part the old code leaked. `me` (the canonical row) is the source for the
	// display username — the session user's `username` can briefly lag right after a
	// setUsername write (see useMe); `me.name` is the display name.
	const username = me?.username ?? null;
	const name = actorLabel(me?.name ?? u?.name ?? null, username, "kullanıcı");
	// The handle line is the chosen username; on the settings page the account is
	// always booted, so `username` is set — the `kullanıcı` fallback is only the
	// defensive not-yet-booted degenerate, never the email local-part.
	const handle = username ?? "kullanıcı";
	// The handle-line standing label, derived from the trusted tier (#1302) instead
	// of the old hard-coded `· yeni üye` lie. `null` (no honest tier) → handle-only,
	// never a placeholder.
	const standingLabel = profileStandingLabel(me?.tier);

	const [draftName, setDraftName] = useState(name);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	// better-auth's session atom starts {data:null, isPending:true} and resolves
	// asynchronously with no synchronous hydration, so on a hard load these hooks run
	// before the session is known and `name` is the "user" fallback — draftName would
	// lock to it and never re-seed. Re-seed the draft when the server name changes out
	// from under the draft we're still showing (initial resolution, or another tab's
	// edit), so a refresh shows the saved name. A draft the user has since edited away
	// from the old server name is left alone, and a save's own refetch doesn't fire the
	// reset because draftName already equals the new name — preserving the "saved" note.
	const serverName = useRef(name);
	useEffect(() => {
		if (draftName === serverName.current) setDraftName(name);
		serverName.current = name;
	}, [name, draftName]);

	if (session.isPending) return null;
	if (!session.data || !u) return <Navigate to="/auth" replace />;

	const trimmed = draftName.trim();
	const canSave = saveState !== "saving" && trimmed.length > 0 && trimmed !== name;

	// Save the görünen ad through the WORKER mutation, not `authClient.updateUser`
	// (#2154): `user.setDisplayName` writes `user.name` AND the stamped
	// `user_profile.display_name` in lockstep, so a rename reaches every author
	// byline. `authClient.updateUser` only touched better-auth `user.name`, which
	// never propagated to the stamped column — the one-shot-sync bug. Refetch `me`
	// (the canonical header row) and the session (better-auth's cached `user.name`)
	// so both surfaces show the saved name.
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
			setRevokeAllError("oturumlar sonlandırılamadı, tekrar dene.");
			setRevokingAll(false);
			return;
		}
		clearBearerToken();
		await authClient.signOut();
		clearBearerToken();
	}

	// account.delete already tore down every session row server-side, so this only
	// drops the now-dead local bearer + refetches the (now empty) session; the
	// <Navigate to="/auth"> guard lands the sessionless user on auth.
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

				{/* The çaylak's own "yazarlığa giden yol" tracker (#1291), surfaced on the
				    self-service profile too (#2203) so promotion progress is reachable from
				    settings, not only the public /u/ page. Reuses the existing block, which
				    self-gates on own-profile + çaylak. */}
				{me?.id ? <CaylakStatusBlock profileUserId={me.id} /> : null}

				{/* Thin contribution signal (#1209) — the owner's own track record. The
				    owner sees their OWN sandboxed content here (the feed keys on authorId
				    with no sandbox filter). */}
				{readUsername ? <ProfileContributionSignal username={readUsername} /> : null}

				<section className="kp-profile__section">
					<h3>hesap</h3>
					<div className="kp-profile__row">
						<span className="label">görünen ad</span>
						<span className="value">
							<Input
								className="kp-profile__name-input"
								aria-label="görünen ad"
								value={draftName}
								onChange={(e) => {
									setDraftName(e.target.value);
									setSaveState("idle");
								}}
								error={saveState === "error" ? "kaydedilemedi, tekrar dene" : undefined}
								disabled={saveState === "saving"}
								fullWidth
							/>
							{saveState === "saved" && <span className="kp-profile__feedback ok">kaydedildi</span>}
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
							{saveState === "saving" ? "kaydediliyor…" : "kaydet"}
						</Button>
					</div>
					<div className="kp-profile__row">
						<span className="label">kullanıcı adı</span>
						<span className="value">@{handle}</span>
						<span className="edit-btn" style={{color: "var(--text-faint)"}}>
							değiştirilemez
						</span>
					</div>
					<div className="kp-profile__row readonly">
						<span className="label">e-posta</span>
						<span className="value">
							{u.email}
							<span className="kp-profile__feedback ok" data-testid="email-change-hint">
								e-posta değiştirme yakında
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
							title="e-posta değiştirme henüz kullanılamıyor"
						>
							değiştir
						</Button>
					</div>
				</section>

				<section className="kp-profile__section">
					<h3>görünüm</h3>
					<div className="kp-profile__row">
						<span className="label">tema</span>
						<span className="value">
							<ToggleGroup
								className="kp-toggle-group kp-toggle-group--outline"
								size="sm"
								items={[
									{value: "light", label: "açık"},
									{value: "dark", label: "koyu"},
									{value: "auto", label: "otomatik"},
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
						<span className="label">yoğunluk</span>
						<span className="value">
							<ToggleGroup
								className="kp-toggle-group kp-toggle-group--outline"
								size="sm"
								items={(["compact", "normal", "spacious"] as Density[]).map((density) => ({
									value: density,
									label: DENSITY_LABELS[density],
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
							<span className="label">çaylak katkıları</span>
							<span className="value">
								çaylakların yazdıklarını akışında görüp görmeyeceğini seçersin.
							</span>
							<Link
								className="edit-btn"
								to={CAYLAK_VISIBILITY_PATH}
								data-testid="caylak-visibility-link"
							>
								ayarla
							</Link>
						</div>
					) : null}
				</section>

				<section className="kp-profile__section">
					<h3>oturum</h3>
					<p>bu cihazda aktif. çıkış yaparak oturumu sonlandırabilirsin.</p>
					<div className="kp-profile__danger">
						<Button type="button" variant="secondary" size="sm" onClick={onSignOut}>
							çıkış yap
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={onSignOutAll}
							disabled={revokingAll}
							loading={revokingAll}
						>
							{revokingAll ? "çıkış yapılıyor…" : "tüm cihazlardan çık"}
						</Button>
					</div>
					{revokeAllError ? (
						<Alert variant="danger" className="kp-alert--inline kp-profile__error">
							{revokeAllError}
						</Alert>
					) : null}
				</section>

				<section className="kp-profile__section kp-profile__section--last">
					<h3 className="danger">tehlikeli alan</h3>
					<p>
						hesabını kaldırırsan başlıkların, tanımların ve yorumların silinmez — @[silinen] adına
						aktarılır, karmaları korunur. hesabın kimliği (e-posta, oturumlar) kalıcı olarak
						kaldırılır; aynı e-posta ileride yeniden kayıt olabilir. bu işlem geri alınamaz.
					</p>
					<div className="kp-profile__danger">
						<Button
							type="button"
							variant="primary"
							size="sm"
							data-testid="delete-account-btn"
							onClick={() => setDeleteOpen(true)}
						>
							hesabı kaldır
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
