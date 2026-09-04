/**
 * `CaylakIdentity` — divan's wrapper over the shared moderation actor row {@link
 * ActorIdentity} (ADR 0147), supplying divan's CSS namespace, test-id prefix and "çaylak"
 * fallback. Two shapes: the presentational one takes the identity fields a BATCHED read
 * already resolved, so the roster renders with no per-row by-id `Profile` read (ADR 0021's
 * no-waterfalls contract); {@link CaylakIdentityById} fetches one profile for the
 * single-çaylak detail, where one by-id read is fine and can suspend or fail.
 */
import {useFateClient, useView, view} from "react-fate";
import type {Profile} from "../../../worker/features/fate/views";
import {useT} from "../../i18n";
import {ActorIdentity} from "../moderation/ActorIdentity";

export function CaylakIdentity({
	authorId,
	displayName,
	username,
	totalKarma,
	showKarma = true,
}: {
	readonly authorId: string;
	readonly displayName: string | null;
	readonly username: string | null;
	readonly totalKarma: number;
	readonly showKarma?: boolean;
}) {
	const t = useT();
	return (
		<ActorIdentity
			authorId={authorId}
			displayName={displayName}
			username={username}
			totalKarma={totalKarma}
			showKarma={showKarma}
			fallbackLabel={t("divan.caylak.fallback")}
			identityClassName="kp-divan__identity"
			handleClassName="kp-divan__handle"
			karmaClassName="kp-divan__karma"
			karmaTestIdPrefix="divan-karma-"
		/>
	);
}

const CaylakProfileView = view<Profile>()({
	id: true,
	userId: true,
	username: true,
	displayName: true,
	totalKarma: true,
});

export function CaylakIdentityById({
	authorId,
	showKarma = true,
}: {
	readonly authorId: string;
	readonly showKarma?: boolean;
}) {
	const fate = useFateClient();
	const ref = fate.ref("Profile", authorId, CaylakProfileView);
	const profile = useView(CaylakProfileView, ref);

	return (
		<CaylakIdentity
			authorId={authorId}
			displayName={profile.displayName ?? null}
			username={profile.username ?? null}
			totalKarma={profile.totalKarma}
			showKarma={showKarma}
		/>
	);
}

export function IdentityFallback() {
	const t = useT();
	return (
		<span className="kp-divan__identity">
			<span className="kp-divan__handle">{t("divan.caylak.fallback")}</span>
		</span>
	);
}
