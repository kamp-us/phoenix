/**
 * `DecisionFeed` — the shared team-ledger surface (#1704, ADR 0098/0138) off the gated
 * `report.listResolved` read. A wave-removal (rows sharing a `waveId`, #1855) collapses into
 * ONE entry whose `Geri getir` restores the batch as a unit; a lone removal keeps its single
 * `report.restore`. A restored row/wave drops from the feed — it is no longer resolved.
 */
import {useCallback, useEffect, useMemo, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {ResolvedReport, ResolveReceipt} from "../../../worker/features/report/views";
import {useT} from "../../i18n";
import {Alert} from "../ui/Alert";
import {Button} from "../ui/Button";
import {
	decisionLabel,
	groupDecisionFeed,
	isRestorable,
	resolverHandle,
	waveEntryLabel,
} from "./decisionFeedGating";
import {itemKindLabel} from "./divanGating";
import {reportAgeLabel, targetAuthorLabel, targetExcerptText, targetHref} from "./raporlarGating";

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

// The ack is requested only to satisfy the mutation's view param; the feed renders nothing
// from it (plain round-trip, no optimistic UI).
const ResolveReceiptView = view<ResolveReceipt>()({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	targetRemoved: true,
	collapsed: true,
});

export function DecisionFeed() {
	const t = useT();
	const result = useRequest({
		"report.listResolved": {list: ResolvedReportConnectionView, args: {first: FEED_PAGE_SIZE}},
	});
	const [items] = useListView(ResolvedReportConnectionView, result["report.listResolved"]);
	const fate = useFateClient();

	// Targets restored this session drop from the feed without a re-fetch — a MODE over the
	// same read.
	const [restoredIds, setRestoredIds] = useState<ReadonlyArray<string>>([]);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// A connection node ref exposes only its id, so each row's `waveId` is lifted off the ref
	// by a hidden `DecisionProbe` before the parent can group waves.
	const [waveById, setWaveById] = useState<Record<string, string | null>>({});
	const onProbe = useCallback((id: string, waveId: string | null) => {
		setWaveById((prev) => (prev[id] === waveId ? prev : {...prev, [id]: waveId}));
	}, []);

	const nodeById = useMemo(() => {
		const map = new Map<string, ViewRef<"ResolvedReport">>();
		for (const {node} of items) map.set(String(node.id), node);
		return map;
	}, [items]);

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
					setError(t("divan.decision.restoreFailed"));
					return;
				}
				setRestoredIds((prev) => [...prev, target.id]);
			} catch {
				setError(t("divan.decision.restoreFailed"));
			} finally {
				setBusyId(null);
			}
		},
		[fate, t],
	);

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
					setError(t("divan.decision.restoreFailed"));
					return;
				}
				setRestoredIds((prev) => [...prev, ...memberIds]);
			} catch {
				setError(t("divan.decision.restoreFailed"));
			} finally {
				setBusyId(null);
			}
		},
		[fate, t],
	);

	if (entries.length === 0) {
		return (
			<>
				{items.map(({node}) => (
					<DecisionProbe key={String(node.id)} node={node} onProbe={onProbe} />
				))}
				<p className="kp-divan__empty" data-testid="divan-decisions-empty">
					{t("divan.decision.empty")}
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
				<Alert
					variant="danger"
					className="kp-alert--inline kp-divan__decisions-error"
					data-testid="divan-decisions-error"
				>
					{error}
				</Alert>
			)}
			<ul
				className="kp-divan__decisions"
				aria-label={t("divan.decisions.label")}
				data-testid="divan-decisions"
			>
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

// A hidden data-loader: lifts one row's `waveId` to the feed so the parent can collapse a
// wave without pre-resolving every row. Renders nothing.
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
	const t = useT();
	const data = useView(ResolvedReportRowView, node);
	const age = reportAgeLabel(data.resolvedAt, Date.now());
	const href = targetHref(data.targetKind, data.targetRef);
	const excerpt = targetExcerptText(data.targetExcerpt) ?? t("divan.excerpt.unavailable");
	const author = targetAuthorLabel(data.targetAuthor);
	const resolver = resolverHandle(data.resolverHandle) ?? t("divan.decision.moderator");
	const restorable = isRestorable(data.resolution);

	return (
		<li
			className="kp-divan__decision-row"
			data-testid={`divan-decision-${data.targetKind}-${data.targetId}`}
		>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind">{t(itemKindLabel(data.targetKind))}</span>
				<span className="kp-divan__decision" data-testid="divan-decision-verdict">
					{t(decisionLabel(data.resolution))}
				</span>
				<span className="kp-divan__decision-by" data-testid="divan-decision-resolver">
					{resolver}
				</span>
				{age !== null && <span className="kp-divan__decision-age">{t(age.key, age.params)}</span>}
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
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="kp-divan__decision-restore"
					disabled={busy}
					loading={busy}
					onClick={() =>
						onRestore({id: String(data.id), targetKind: data.targetKind, targetId: data.targetId})
					}
					data-testid="divan-decision-restore"
				>
					{t("divan.decision.restore")}
				</Button>
			)}
		</li>
	);
}

// The shared decision + resolver are read off the wave's first member — a wave stamps one
// uniform triad across its targets.
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
	const t = useT();
	const data = useView(ResolvedReportRowView, node);
	const age = reportAgeLabel(data.resolvedAt, Date.now());
	const wave = waveEntryLabel(memberCount);
	const resolver = resolverHandle(data.resolverHandle) ?? t("divan.decision.moderator");
	const restorable = isRestorable(data.resolution);

	return (
		<li className="kp-divan__decision-row" data-testid={`divan-decision-wave-${data.waveId}`}>
			<span className="kp-divan__item-meta">
				<span className="kp-divan__kind" data-testid="divan-decision-wave-count">
					{t(wave.key, wave.params)}
				</span>
				<span className="kp-divan__decision" data-testid="divan-decision-verdict">
					{t(decisionLabel(data.resolution))}
				</span>
				<span className="kp-divan__decision-by" data-testid="divan-decision-resolver">
					{resolver}
				</span>
				{age !== null && <span className="kp-divan__decision-age">{t(age.key, age.params)}</span>}
			</span>
			{restorable && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="kp-divan__decision-restore"
					disabled={busy}
					loading={busy}
					onClick={onRestore}
					data-testid="divan-decision-restore-wave"
				>
					{t("divan.decision.restore")}
				</Button>
			)}
		</li>
	);
}
