/**
 * `DecisionFeed` — the shared team-ledger surface (#1704, ADR 0098/0138): a moderator's
 * view of recent decisions off the gated `report.listResolved` read (`Moderate`-gated
 * server-side; a non-moderator's read denies the invisible `UNAUTHORIZED`, caught by the
 * page's `<Screen>`). Each row names the decided target, the decision (kaldırıldı /
 * yoksayıldı), the **resolver** (which mod — first-class, not a footnote), and when —
 * so "what did my brother already decide" is legible across both moderators.
 *
 * A wave-removal (rows sharing a `waveId`, #1855) collapses into ONE feed entry — "N hedef ·
 * dalga" — whose `Geri getir` triggers `report.restoreWave`, restoring the batch as a unit
 * (every target back live + every report reopened). A lone removal (null `waveId`) keeps its
 * single `report.restore`. The pure grouping (`groupDecisionFeed`) is unit-tested DOM-free;
 * each row's `waveId` is lifted off its ref by a hidden `DecisionProbe` (the #1855
 * `WaveProbe` idiom), since a connection node ref exposes only its id. A restored row/wave
 * drops from the feed (it's no longer resolved).
 *
 * a11y (the divan baseline): a real `<ul>` list, decision/resolver/age as text (never
 * color), lowercase Turkish copy.
 */
import {useCallback, useEffect, useMemo, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {ResolvedReport, ResolveReceipt} from "../../../worker/features/report/views";
import {
	decisionLabel,
	groupDecisionFeed,
	isRestorable,
	resolverLabel,
	waveEntryLabel,
} from "./decisionFeedGating";
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
	waveId: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
});

const ResolvedReportConnectionView = {items: {node: ResolvedReportRowView}} as const;

// The `report.restore` / `report.restoreWave` ack (ADR 0098) — the result-only
// `ResolveReceipt`. The feed doesn't render the ack (plain round-trip); it's requested to
// satisfy the mutation view.
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

	// Targets restored this session drop from the feed without a re-fetch (a restore reopens
	// the group, so it's no longer a decision) — the same MODE-over-the-read the triage loop
	// uses for resolved ids.
	const [restoredIds, setRestoredIds] = useState<ReadonlyArray<string>>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// A connection node ref exposes only its id; each row's `waveId` is lifted off the ref by
	// a hidden `DecisionProbe` (the #1855 `WaveProbe` idiom) so the parent can group waves.
	const [waveById, setWaveById] = useState<Record<string, string | null>>({});
	const onProbe = useCallback((id: string, waveId: string | null) => {
		setWaveById((prev) => (prev[id] === waveId ? prev : {...prev, [id]: waveId}));
	}, []);

	const nodeById = useMemo(() => {
		const map = new Map<string, ViewRef<"ResolvedReport">>();
		for (const {node} of items) map.set(String(node.id), node);
		return map;
	}, [items]);

	// Group the live (not-yet-restored) rows into feed entries — waves collapse to one entry.
	const liveRows = items
		.map(({node}) => ({id: String(node.id), waveId: waveById[String(node.id)] ?? null}))
		.filter((r) => !restoredIds.includes(r.id));
	const entries = groupDecisionFeed(liveRows);

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

	// Restore a whole wave as a unit (#1855): one `report.restoreWave` reopens every report
	// sharing the id AND brings every target back live; all members drop from the feed.
	const restoreWave = useCallback(
		async (waveId: string, memberIds: ReadonlyArray<string>) => {
			setBusyId(waveId);
			setError(null);
			try {
				const {error: callError} = await fate.mutations.report.restoreWave({
					input: {waveId},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError("geri getirilemedi, tekrar dene.");
					return;
				}
				setRestoredIds((prev) => [...prev, ...memberIds]);
			} catch {
				setError("geri getirilemedi, tekrar dene.");
			} finally {
				setBusyId(null);
			}
		},
		[fate],
	);

	if (entries.length === 0) {
		return (
			<>
				{items.map(({node}) => (
					<DecisionProbe key={String(node.id)} node={node} onProbe={onProbe} />
				))}
				<p className="kp-divan__empty" data-testid="divan-decisions-empty">
					henüz karar yok — verilen kararlar burada görünür.
				</p>
			</>
		);
	}

	return (
		<>
			{items.map(({node}) => (
				<DecisionProbe key={String(node.id)} node={node} onProbe={onProbe} />
			))}
			{error && (
				<p className="kp-divan__decisions-error" role="alert" data-testid="divan-decisions-error">
					{error}
				</p>
			)}
			<ul className="kp-divan__decisions" aria-label="son kararlar" data-testid="divan-decisions">
				{entries.map((entry) => {
					if (entry.kind === "wave") {
						const first = nodeById.get(entry.memberIds[0] ?? "");
						if (!first) return null;
						return (
							<WaveDecisionRow
								key={entry.waveId}
								node={first}
								memberCount={entry.memberIds.length}
								busy={busyId !== null}
								onRestore={() => restoreWave(entry.waveId, entry.memberIds)}
							/>
						);
					}
					const node = nodeById.get(entry.id);
					if (!node) return null;
					return (
						<DecisionRow key={entry.id} node={node} busy={busyId !== null} onRestore={restore} />
					);
				})}
			</ul>
		</>
	);
}

// A hidden data-loader: lifts one decision row's `waveId` off its ref to the feed, so the
// parent can collapse a wave into one entry without pre-resolving every row (the #1855
// `WaveProbe` idiom). Renders nothing.
function DecisionProbe({
	node,
	onProbe,
}: {
	readonly node: ViewRef<"ResolvedReport">;
	readonly onProbe: (id: string, waveId: string | null) => void;
}) {
	const data = useView(ResolvedReportRowView, node);
	useEffect(() => {
		onProbe(String(data.id), data.waveId);
	}, [data.id, data.waveId, onProbe]);
	return null;
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

// One wave-removal (#1855) as a single feed entry: "N hedef · dalga". The shared decision +
// resolver are read off the wave's first member (a wave stamps one uniform triad across its
// targets), and `Geri getir` restores the whole batch as a unit (`report.restoreWave`).
function WaveDecisionRow({
	node,
	memberCount,
	busy,
	onRestore,
}: {
	readonly node: ViewRef<"ResolvedReport">;
	readonly memberCount: number;
	readonly busy: boolean;
	readonly onRestore: () => void;
}) {
	const data = useView(ResolvedReportRowView, node);
	const age = reportAgeLabel(data.resolvedAt, Date.now());
	const restorable = isRestorable(data.resolution);

	return (
		<li className="kp-divan__decision-row" data-testid={`divan-decision-wave-${data.waveId}`}>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind" data-testid="divan-decision-wave-count">
					{waveEntryLabel(memberCount)}
				</span>
				<span className="kp-divan__decision" data-testid="divan-decision-verdict">
					{decisionLabel(data.resolution)}
				</span>
				<span className="kp-divan__decision-by" data-testid="divan-decision-resolver">
					{resolverLabel(data.resolverHandle)}
				</span>
				{age !== null && <span className="kp-divan__decision-age">{age}</span>}
			</span>
			{restorable && (
				<button
					type="button"
					className="kp-divan__decision-restore"
					disabled={busy}
					onClick={onRestore}
					data-testid="divan-decision-restore-wave"
				>
					geri getir
				</button>
			)}
		</li>
	);
}
