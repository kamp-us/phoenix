/**
 * `CaylakDetail` — one çaylak's review surface in the divan (#1290). Every read is the
 * gated `divan.backlog` destination (#1205) — the one-way glass: çaylak work is visible
 * ONLY here, never a widening of the inline `{mod, author}` filter. The backlog item view
 * carries no live score, so a per-item upvote shows its count only after the cast returns a
 * receipt.
 */

import {Alert, Button, ReportButton, type ReportOutcome, ReviewBadge} from "@kampus/design";
import {useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {
	DivanVoteReceipt,
	PromotionReceipt,
	ReportReceipt,
} from "../../../worker/features/fate/views";
import type {Tier} from "../../../worker/features/kunye/standing";
import {Screen} from "../../fate/Screen";
import {codeOf} from "../../fate/wire";
import {VoteTriangle} from "../VoteTriangle";
import {CaylakIdentityById, IdentityFallback} from "./CaylakIdentity";
import {
	itemKindLabel,
	parseBacklogItemId,
	promoteOutcome,
	promoteOutcomeMessage,
	promoteRefreshWarranted,
	promoteVisible,
	type VouchOutcome,
	vouchLanded,
	vouchTriggerLabel,
	vouchTriggerState,
} from "./divanGating";
import {
	BacklogConnectionView,
	BacklogItemView,
	divanBacklogRequest,
	refreshDivanReview,
} from "./divanReads";
import {VouchSheet} from "./VouchSheet";

const VoteReceiptView = view<DivanVoteReceipt>()({
	id: true,
	score: true,
	myVote: true,
});

const ReportReceiptView = view<ReportReceipt>()({
	id: true,
	targetKind: true,
	targetId: true,
	created: true,
});

const PromotionReceiptView = view<PromotionReceipt>()({
	userId: true,
	promoted: true,
	vouchRecorded: true,
});

export function CaylakDetail({
	authorId,
	viewerTier,
	viewerIsModerator,
	viewerVouched,
}: {
	readonly authorId: string;
	readonly viewerTier: Tier | undefined;
	readonly viewerIsModerator: boolean;
	/**
	 * Off the roster row this detail was opened from, so the durable "already a kefil"
	 * state rides the roster's own batched read — no by-id read of this çaylak (ADR 0021).
	 */
	readonly viewerVouched: boolean;
}) {
	const result = useRequest(divanBacklogRequest(authorId));
	const [items] = useListView(BacklogConnectionView, result["divan.backlog"]);

	return (
		<section
			className="kp-divan__detail"
			aria-label="çaylak incelemesi"
			data-testid="caylak-detail"
		>
			<header className="kp-divan__detail-head">
				<Screen fallback={<IdentityFallback />} error={() => <IdentityFallback />}>
					<CaylakIdentityById authorId={authorId} />
				</Screen>
				<ReviewerActions
					authorId={authorId}
					viewerTier={viewerTier}
					viewerIsModerator={viewerIsModerator}
					viewerVouched={viewerVouched}
				/>
			</header>

			<h3 className="kp-divan__detail-title">incelemedeki içerikler</h3>
			{items.length === 0 ? (
				<p className="kp-divan__empty">bu çaylağın incelemede bekleyen içeriği yok.</p>
			) : (
				<ul className="kp-divan__backlog">
					{items.map(({node}) => (
						<BacklogItemRow key={node.id} node={node} />
					))}
				</ul>
			)}
		</section>
	);
}

function ReviewerActions({
	authorId,
	viewerTier,
	viewerIsModerator,
	viewerVouched,
}: {
	readonly authorId: string;
	readonly viewerTier: Tier | undefined;
	readonly viewerIsModerator: boolean;
	readonly viewerVouched: boolean;
}) {
	const fate = useFateClient();
	const [vouchOpen, setVouchOpen] = useState(false);
	// OR-ed with the prop rather than seeded from it, so a landed confirm shows immediately
	// AND a refreshed roster row still wins after this component remounts on re-selection.
	const [justVouched, setJustVouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	async function onPromote() {
		if (busy) return;
		setBusy(true);
		setMessage("");
		try {
			const {result, error} = await fate.mutations.user.promote({
				input: {userId: authorId},
				view: PromotionReceiptView,
			});
			const code = error ? codeOf(error) : null;
			const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
			const outcome = promoteOutcome(
				(result as {promoted?: boolean} | null)?.promoted,
				denied,
				!!error && !denied,
			);
			setMessage(promoteOutcomeMessage(outcome));
			// Fire-and-forget: the promote DID succeed, so a failed refresh must not
			// overwrite its message — the lists just stay as they were.
			if (promoteRefreshWarranted(outcome)) {
				void refreshDivanReview(fate, authorId).catch(() => undefined);
			}
		} catch (caught) {
			const code = codeOf(caught);
			const denied = code === "UNAUTHORIZED" || code === "FORBIDDEN";
			setMessage(promoteOutcomeMessage(promoteOutcome(undefined, denied, !denied)));
		} finally {
			setBusy(false);
		}
	}

	function onVouchResolved(outcome: VouchOutcome) {
		if (!vouchLanded(outcome)) return;
		setJustVouched(true);
		// Fire-and-forget, as the promote path does: the vouch DID land, so a failed
		// re-pull must leave the surface alone — the local flag already told the truth.
		void refreshDivanReview(fate, authorId).catch(() => undefined);
	}

	const showPromote = promoteVisible(viewerIsModerator);
	const vouchState = vouchTriggerState(viewerTier, viewerVouched || justVouched);
	const showVouch = vouchState !== "hidden";

	if (!showPromote && !showVouch) return null;

	return (
		<div className="kp-divan__actions">
			<div className="kp-divan__action-buttons">
				{showPromote ? (
					<Button
						variant="primary"
						size="sm"
						onClick={onPromote}
						disabled={busy}
						data-testid="promote-button"
					>
						{busy ? "yükseltiliyor…" : "yazar yap"}
					</Button>
				) : null}
				{showVouch ? (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => setVouchOpen(true)}
						disabled={vouchState === "done"}
						data-testid="vouch-button"
					>
						{vouchTriggerLabel(vouchState)}
					</Button>
				) : null}
			</div>
			{message ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-divan__status"
					aria-live="polite"
					data-testid="promote-status"
				>
					{message}
				</Alert>
			) : null}
			{showVouch ? (
				<VouchSheet
					open={vouchOpen}
					onOpenChange={setVouchOpen}
					candidateId={authorId}
					onResolved={onVouchResolved}
				/>
			) : null}
		</div>
	);
}

function BacklogItemRow({node}: {readonly node: ViewRef<"DivanBacklogItem">}) {
	const data = useView(BacklogItemView, node);
	const fate = useFateClient();
	const [score, setScore] = useState<number | null>(null);
	const [mine, setMine] = useState(false);
	const [voteBusy, setVoteBusy] = useState(false);

	async function onVote() {
		if (voteBusy) return;
		setVoteBusy(true);
		const next = !mine;
		try {
			const {result, error} = await fate.mutations.divan.vote({
				input: {id: data.id, value: next},
				view: VoteReceiptView,
			});
			if (!error && result) {
				const receipt = result as {score: number; myVote: boolean};
				setScore(receipt.score);
				setMine(receipt.myVote);
			}
		} catch {
			// A denied/raced cast leaves the local state unchanged — the gate already
			// denied a non-divan actor server-side; nothing to surface on the item.
		} finally {
			setVoteBusy(false);
		}
	}

	async function onReport(): Promise<ReportOutcome> {
		const target = parseBacklogItemId(data.id);
		if (!target) return "error";
		try {
			const {result, error} = await fate.mutations.report.submit({
				input: {targetKind: target.targetKind, targetId: target.targetId},
				view: ReportReceiptView,
			});
			if (error) return "error";
			return (result as {created?: boolean} | null)?.created === false ? "already" : "reported";
		} catch {
			return "error";
		}
	}

	return (
		<li className="kp-divan__item" data-testid={`divan-item-${data.id}`}>
			<div className="kp-divan__item-vote">
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="kp-divan__upvote"
					onClick={onVote}
					disabled={voteBusy}
					pressed={mine}
					aria-label={mine ? "oyu geri çek" : "oy ver"}
					data-testid={`divan-upvote-${data.id}`}
				>
					<VoteTriangle />
				</Button>
				{score !== null ? (
					<span className="kp-divan__score" data-testid={`divan-score-${data.id}`}>
						{score}
					</span>
				) : null}
			</div>
			<div className="kp-divan__item-body">
				<div className="kp-divan__item-meta">
					<span className="kp-divan__kind">{itemKindLabel(data.kind)}</span>
					<ReviewBadge />
				</div>
				<p className="kp-divan__preview">{data.preview || "(boş)"}</p>
			</div>
			<ReportButton
				onReport={onReport}
				className="kp-divan__bildir"
				testId={`divan-bildir-${data.id}`}
			/>
		</li>
	);
}
