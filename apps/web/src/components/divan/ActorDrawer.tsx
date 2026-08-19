/**
 * `ActorDrawer` — the künye actor-drawer (#1852, ADR 0138): a docked side-panel rendering
 * the focused report's actor off the SAME `Moderate`-gated `report.listOpen` row the triage
 * loop consumes, never a re-fetch. The render + hop decisions live DOM-free in
 * `actor-drawer.ts`; this is the thin shell.
 */
import type {OpenReport} from "../../../worker/features/report/views";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_USER_BAN} from "../../flags/keys";
import {BanControls} from "../moderation/BanControls";
import {Button} from "../ui/Button";
import {Surface} from "../ui/Card";
import {
	type ActorStanding,
	actorIdentityLabel,
	bildirilenLabel,
	buAktorLabel,
	type Chamber,
	kaldirilanLabel,
	kefilDurumuLabel,
	modRecordVerdicts,
	uretimLabel,
} from "./actor-drawer";

function standingOf(data: OpenReport): ActorStanding {
	return {
		tier: data.authorTier,
		karma: data.authorKarma,
		priorRemovals: data.authorPriorRemovals,
		distinctReporters: data.distinctReporters,
		definitionCount: data.authorDefinitionCount,
		postCount: data.authorPostCount,
		commentCount: data.authorCommentCount,
		kefil: data.authorKefil,
		reportedTargets: data.authorReportedTargets,
	};
}

export function ActorDrawer({
	data,
	chamber,
	onHopKefil,
	onHopModeration,
}: {
	readonly data: OpenReport;
	readonly chamber: Chamber;
	readonly onHopKefil: () => void;
	readonly onHopModeration: () => void;
}) {
	const standing = standingOf(data);
	const identity = actorIdentityLabel(data.targetAuthor, standing);
	const uretim = uretimLabel(standing);
	const kaldirilan = kaldirilanLabel(standing.priorRemovals);
	const kefilDurumu = kefilDurumuLabel(standing.kefil);
	const buAktor = buAktorLabel(standing.reportedTargets);
	const recordVerdicts = modRecordVerdicts(chamber);

	return (
		<Surface
			as="aside"
			tone="raised"
			radius="sm"
			padding="lg"
			border
			className="kp-actor"
			aria-label="aktör künyesi"
			data-testid="actor-drawer"
		>
			<header className="kp-actor__head">
				<span className="kp-actor__identity" data-testid="actor-identity">
					{identity ?? "aktör bilinmiyor"}
				</span>
			</header>

			<dl className="kp-actor__tells">
				{uretim !== null && (
					<div className="kp-actor__tell">
						<dt className="kp-actor__tell-key">üretim</dt>
						<dd className="kp-actor__tell-val" data-testid="actor-uretim">
							{uretim}
						</dd>
					</div>
				)}
				{kaldirilan !== null && (
					<div className="kp-actor__tell">
						<dt className="kp-actor__tell-key">sicil</dt>
						<dd className="kp-actor__tell-val" data-testid="actor-kaldirilan">
							{kaldirilan}
						</dd>
					</div>
				)}
				<div className="kp-actor__tell">
					<dt className="kp-actor__tell-key">bildiren</dt>
					<dd className="kp-actor__tell-val" data-testid="actor-bildirilen">
						{bildirilenLabel(standing.distinctReporters)}
					</dd>
				</div>
				{kefilDurumu !== null && (
					<div className="kp-actor__tell">
						<dt className="kp-actor__tell-key">kefil</dt>
						<dd className="kp-actor__tell-val" data-testid="actor-kefil">
							{kefilDurumu}
						</dd>
					</div>
				)}
				{buAktor !== null && (
					<div className="kp-actor__tell">
						<dt className="kp-actor__tell-key">bu aktör</dt>
						<dd className="kp-actor__tell-val" data-testid="actor-bu-aktor">
							{buAktor}
						</dd>
					</div>
				)}
			</dl>

			{chamber === "kefil" && (
				<p
					className="kp-actor__guard"
					role="note"
					data-testid="actor-kefil-guard"
					data-verdicts={recordVerdicts}
				>
					mod sicili bilgilendirir, kefil kararını vermez.
				</p>
			)}

			{/* Ban/unban (#970) — dark behind `phoenix-user-ban` (ADR 0083) and admin-gated
			    server-side; only rendered for a resolvable actor id. */}
			{data.authorId !== null && (
				<FlagGate flag={PHOENIX_USER_BAN}>
					<BanControls userId={data.authorId} />
				</FlagGate>
			)}

			<div className="kp-actor__hops">
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="kp-actor__hop"
					onClick={onHopKefil}
					aria-current={chamber === "kefil" ? "true" : undefined}
					data-testid="actor-hop-kefil"
				>
					kefil (V)
				</Button>
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="kp-actor__hop"
					onClick={onHopModeration}
					aria-current={chamber === "raporlar" ? "true" : undefined}
					data-testid="actor-hop-moderation"
				>
					moderasyon (M)
				</Button>
			</div>
		</Surface>
	);
}
