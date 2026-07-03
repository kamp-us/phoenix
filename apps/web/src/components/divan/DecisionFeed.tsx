/**
 * `DecisionFeed` — the shared team-ledger surface (#1704, ADR 0098/0138): a moderator's
 * view of recent decisions off the gated `report.listResolved` read (`Moderate`-gated
 * server-side; a non-moderator's read denies the invisible `UNAUTHORIZED`, caught by the
 * page's `<Screen>`). Each row names the decided target, the decision (kaldırıldı /
 * yoksayıldı), the **resolver** (which mod — first-class, not a footnote), and when —
 * so "what did my brother already decide" is legible across both moderators.
 *
 * A `removed` decision carries `Geri getir` (restore) as the disagreement affordance,
 * wired to the existing `report.restore` mutation (brings content back live + reopens
 * its report group). A restored row drops from the feed (it's no longer resolved).
 * Restore is wave-ready: it acts on the target, and `report.restore` reopens the whole
 * target group as a unit — the #1855 wave-batch fan-out docks onto this same path when
 * the wave manifest lands (out of scope here, built additively in parallel).
 *
 * a11y (the divan baseline): a real `<ul>` list, decision/resolver/age as text (never
 * color), lowercase Turkish copy.
 */
import {useCallback, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {ResolvedReport, ResolveReceipt} from "../../../worker/features/report/views";
import {decisionLabel, isRestorable, resolverLabel} from "./decisionFeedGating";
import {itemKindLabel} from "./divanGating";
import {reportAgeLabel, targetAuthorLabel, targetExcerptLabel, targetHref} from "./raporlarGating";

const FEED_PAGE_SIZE = 50;

const ResolvedReportRowView = view<ResolvedReport>()({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	resolverId: true,
	resolverHandle: true,
	resolvedAt: true,
	reportCount: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
});

const ResolvedReportConnectionView = {items: {node: ResolvedReportRowView}} as const;

// The `report.restore` ack (ADR 0098) — the result-only `ResolveReceipt`. The feed
// doesn't render the ack (plain round-trip); it's requested to satisfy the mutation view.
const ResolveReceiptView = view<ResolveReceipt>()({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	targetRemoved: true,
	collapsed: true,
});

export function DecisionFeed() {
	const result = useRequest({
		"report.listResolved": {list: ResolvedReportConnectionView, args: {first: FEED_PAGE_SIZE}},
	});
	const [items] = useListView(ResolvedReportConnectionView, result["report.listResolved"]);
	const fate = useFateClient();

	// Targets restored this session drop from the feed without a re-fetch (a restore
	// reopens the group, so it's no longer a decision) — the same MODE-over-the-read the
	// triage loop uses for resolved ids.
	const [restoredIds, setRestoredIds] = useState<ReadonlyArray<string>>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const live = items.filter(({node}) => !restoredIds.includes(String(node.id)));

	const restore = useCallback(
		async (target: {id: string; targetKind: ResolvedReport["targetKind"]; targetId: string}) => {
			setBusyId(target.id);
			setError(null);
			try {
				const {error: callError} = await fate.mutations.report.restore({
					input: {targetKind: target.targetKind, targetId: target.targetId},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError("geri getirilemedi, tekrar dene.");
					return;
				}
				setRestoredIds((prev) => [...prev, target.id]);
			} catch {
				setError("geri getirilemedi, tekrar dene.");
			} finally {
				setBusyId(null);
			}
		},
		[fate],
	);

	if (live.length === 0) {
		return (
			<p className="kp-divan__empty" data-testid="divan-decisions-empty">
				henüz karar yok — verilen kararlar burada görünür.
			</p>
		);
	}

	return (
		<>
			{error && (
				<p className="kp-divan__decisions-error" role="alert" data-testid="divan-decisions-error">
					{error}
				</p>
			)}
			<ul className="kp-divan__decisions" aria-label="son kararlar" data-testid="divan-decisions">
				{live.map(({node}) => (
					<DecisionRow key={node.id} node={node} busy={busyId !== null} onRestore={restore} />
				))}
			</ul>
		</>
	);
}

function DecisionRow({
	node,
	busy,
	onRestore,
}: {
	readonly node: ViewRef<"ResolvedReport">;
	readonly busy: boolean;
	readonly onRestore: (target: {
		id: string;
		targetKind: ResolvedReport["targetKind"];
		targetId: string;
	}) => void;
}) {
	const data = useView(ResolvedReportRowView, node);
	const age = reportAgeLabel(data.resolvedAt, Date.now());
	const href = targetHref(data.targetKind, data.targetRef);
	const excerpt = targetExcerptLabel(data.targetExcerpt);
	const author = targetAuthorLabel(data.targetAuthor);
	const restorable = isRestorable(data.resolution);

	return (
		<li
			className="kp-divan__decision-row"
			data-testid={`divan-decision-${data.targetKind}-${data.targetId}`}
		>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind">{itemKindLabel(data.targetKind)}</span>
				<span className="kp-divan__decision" data-testid="divan-decision-verdict">
					{decisionLabel(data.resolution)}
				</span>
				<span className="kp-divan__decision-by" data-testid="divan-decision-resolver">
					{resolverLabel(data.resolverHandle)}
				</span>
				{age !== null && <span className="kp-divan__decision-age">{age}</span>}
			</span>
			<p className="kp-divan__decision-target">
				{href !== null ? (
					<a className="kp-divan__decision-link" href={href}>
						{excerpt}
					</a>
				) : (
					<span className="kp-divan__decision-excerpt">{excerpt}</span>
				)}
				{author !== null && <span className="kp-divan__decision-author">{author}</span>}
			</p>
			{restorable && (
				<button
					type="button"
					className="kp-divan__decision-restore"
					disabled={busy}
					onClick={() =>
						onRestore({id: String(data.id), targetKind: data.targetKind, targetId: data.targetId})
					}
					data-testid="divan-decision-restore"
				>
					geri getir
				</button>
			)}
		</li>
	);
}
