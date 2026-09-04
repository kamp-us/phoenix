/**
 * `TriageLoop` — the moderation triage-loop hero (#1703, ADR 0138): a single-item,
 * keyboard-driven review over the SAME `Moderate`-gated `report.listOpen` read the grid
 * (`Raporlar`, #1701) consumes — a MODE, not a re-fetch. Verdicts wire to the existing
 * `report.resolve` (plain round-trip, no optimistic UI); a failed resolve leaves the row
 * actionable rather than dropping it. The pure decisions live DOM-free in `triage-loop.ts`;
 * this component is the thin React shell over them.
 */

import {Alert, Badge, Button, Kbd, Surface} from "@kampus/design";
import {useCallback, useEffect, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {OpenReport, ResolveReceipt} from "../../../worker/features/report/views";
import {plural, useLocale, useT} from "../../i18n";
import {ActorDrawer} from "./ActorDrawer";
import {type Chamber, drawerDefaultOpen, drawerKeyToAction, hopTarget} from "./actor-drawer";
import {itemKindLabel, parseBacklogItemId} from "./divanGating";
import {reasonText, reportAgeLabel, targetExcerptText, targetHref} from "./raporlarGating";
import {
	blastRadiusLabel,
	buildWaveManifest,
	canApplyWave,
	initialWaveSelection,
	isWaveSelected,
	selectAllWave,
	selectedWaveTargets,
	summarizeWaveBatch,
	toggleWaveRow,
	type WaveOutcome,
	type WaveResolveInput,
	type WaveRow,
	waveConfirmKey,
	waveFailureLabel,
	waveKeyToAction,
	waveManifestLabel,
	waveResolveInputs,
	waveTargetKey,
} from "./remove-the-wave";
import {
	authorReputationLabel,
	drainedLabel,
	escapeTo,
	focusAfterResolve,
	keyToAction,
	type LoopLayer,
	maskedExcerpt,
	moveFocus,
	needsConfirm,
	reporterDiversityLabel,
	triageLegend,
	type Verdict,
} from "./triage-loop";

const QUEUE_PAGE_SIZE = 50;

const OpenReportLoopView = view<OpenReport>()({
	id: true,
	targetKind: true,
	targetId: true,
	reportCount: true,
	reason: true,
	firstReportedAt: true,
	targetExcerpt: true,
	targetAuthor: true,
	targetRef: true,
	authorId: true,
	distinctReporters: true,
	authorTier: true,
	authorKarma: true,
	authorPriorRemovals: true,
	authorDefinitionCount: true,
	authorPostCount: true,
	authorCommentCount: true,
	authorKefil: true,
	authorReportedTargets: true,
});

const OpenReportConnectionView = {items: {node: OpenReportLoopView}} as const;

// The ack is requested only to satisfy the mutation's view param; the loop renders nothing
// from it (plain round-trip, no optimistic UI).
const ResolveReceiptView = view<ResolveReceipt>()({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	targetRemoved: true,
	collapsed: true,
});

type LastVerdict =
	| {
			readonly kind: "single";
			readonly targetKind: OpenReport["targetKind"];
			readonly targetId: string;
			readonly verdict: Verdict;
	  }
	| {readonly kind: "wave"; readonly waveId: string; readonly keys: ReadonlyArray<string>};

export function TriageLoop({onExit}: {readonly onExit: () => void}) {
	const t = useT();
	const result = useRequest({
		"report.listOpen": {list: OpenReportConnectionView, args: {first: QUEUE_PAGE_SIZE}},
	});
	const [items] = useListView(OpenReportConnectionView, result["report.listOpen"]);
	const fate = useFateClient();

	const [index, setIndex] = useState(0);
	const [revealed, setRevealed] = useState(false);
	const [pending, setPending] = useState<Verdict | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [decisionsToday, setDecisionsToday] = useState(0);
	const [lastVerdict, setLastVerdict] = useState<LastVerdict | null>(null);

	// `chamber` is which mode the drawer was entered from; a hop only re-lenses the SAME actor,
	// it never re-fetches. Desktop is a coarse pointer + wide viewport.
	const isDesktop =
		typeof window !== "undefined" && window.matchMedia?.("(min-width: 900px)").matches === true;
	const [drawerOpen, setDrawerOpen] = useState(() => drawerDefaultOpen(isDesktop));
	const [chamber, setChamber] = useState<Chamber>("raporlar");

	// The ids resolved this session present the post-collapse queue without a re-fetch.
	const [resolvedIds, setResolvedIds] = useState<ReadonlyArray<string>>([]);
	const live = items.filter(({node}) => !resolvedIds.includes(String(node.id)));

	const focused = live[Math.min(index, Math.max(0, live.length - 1))] ?? null;
	const focusedTarget = focused ? parseBacklogItemId(String(focused.node.id)) : null;

	// The null-tolerant `useView` subscribes to the focused ref only; the manifest's other rows
	// load lazily inside `WaveManifest`.
	const focusedData = useView(OpenReportLoopView, focused?.node ?? null);
	const [waveOpen, setWaveOpen] = useState(false);

	const resolve = useCallback(
		async (target: {targetKind: OpenReport["targetKind"]; targetId: string}, verdict: Verdict) => {
			setBusy(true);
			setError(null);
			try {
				const {error: callError} = await fate.mutations.report.resolve({
					input: {targetKind: target.targetKind, targetId: target.targetId, action: verdict},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError(t("divan.triage.resolveFailed"));
					return;
				}
				setResolvedIds((prev) => [...prev, `${target.targetKind}:${target.targetId}`]);
				setLastVerdict({
					kind: "single",
					targetKind: target.targetKind,
					targetId: target.targetId,
					verdict,
				});
				setDecisionsToday((n) => n + 1);
				setRevealed(false);
				setPending(null);
				setIndex((i) => focusAfterResolve(i, live.length - 1));
			} catch {
				setError(t("divan.triage.resolveFailed"));
			} finally {
				setBusy(false);
			}
		},
		[fate, live.length, t],
	);

	const undo = useCallback(async () => {
		const last = lastVerdict;
		if (!last) return;
		setBusy(true);
		setError(null);
		try {
			// A wave-removal (#1855) undoes as a UNIT via `report.restoreWave`; a lone verdict is the
			// single-target restore (ADR 0098 §3).
			if (last.kind === "wave") {
				const {error: callError} = await fate.mutations.report.restoreWave({
					input: {waveId: last.waveId},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError(t("divan.triage.undoFailed"));
					return;
				}
				setResolvedIds((prev) => prev.filter((x) => !last.keys.includes(x)));
				setDecisionsToday((n) => Math.max(0, n - last.keys.length));
			} else {
				const {error: callError} = await fate.mutations.report.restore({
					input: {targetKind: last.targetKind, targetId: last.targetId},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError(t("divan.triage.undoFailed"));
					return;
				}
				const id = `${last.targetKind}:${last.targetId}`;
				setResolvedIds((prev) => prev.filter((x) => x !== id));
				setDecisionsToday((n) => Math.max(0, n - 1));
			}
			setLastVerdict(null);
		} catch {
			setError(t("divan.triage.undoFailed"));
		} finally {
			setBusy(false);
		}
	}, [fate, lastVerdict, t]);

	// Returns whether it landed, so the batch can partition resolved from failed — no silent
	// partial drop.
	const resolveTarget = useCallback(
		async (input: WaveResolveInput, verdict: Verdict): Promise<boolean> => {
			try {
				const {error: callError} = await fate.mutations.report.resolve({
					input: {
						targetKind: input.targetKind,
						targetId: input.targetId,
						action: verdict,
						waveId: input.waveId,
					},
					view: ResolveReceiptView,
				});
				return !callError;
			} catch {
				return false;
			}
		},
		[fate],
	);

	// Mirror the single-verdict bookkeeping without a re-fetch, and record the wave as the last
	// verdict so `U` undoes the whole batch as a unit.
	const onWaveResolved = useCallback((keys: ReadonlyArray<string>, waveId: string) => {
		if (keys.length === 0) return;
		setResolvedIds((prev) => [...prev, ...keys]);
		setDecisionsToday((n) => n + keys.length);
		setLastVerdict({kind: "wave", waveId, keys});
	}, []);

	// `Tab`/`Escape` are prevented from their default so the loop owns them while it is the
	// active surface.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (busy) return;
			// While the wave manifest is open it owns the keyboard entirely; the loop stands down.
			if (waveOpen) return;

			// `Shift-X` grabs into the wave manifest only when the actor resolves — an anonymized
			// row has no author to group.
			if (pending === null) {
				const wave = waveKeyToAction({key: e.key, code: e.code, altKey: e.altKey});
				if (wave?.kind === "grab") {
					e.preventDefault();
					if (focusedData?.authorId != null) setWaveOpen(true);
					return;
				}
			}

			// The drawer bindings take precedence over the loop's own, but only outside a confirm sheet
			// (a sheet narrows to its own keys).
			if (pending === null) {
				const drawer = drawerKeyToAction(e.key);
				if (drawer !== null) {
					e.preventDefault();
					if (drawer.kind === "toggleDrawer") {
						setDrawerOpen((open) => !open);
					} else {
						const target = hopTarget(drawer);
						if (target !== null) {
							setChamber(target);
							setDrawerOpen(true);
						}
					}
					return;
				}
			}

			const action = keyToAction(e.key);
			if (action === null) return;

			if (pending !== null) {
				if (action.kind === "escape") {
					e.preventDefault();
					setPending(null);
				} else if (action.kind === "remove" && focusedTarget) {
					e.preventDefault();
					void resolve(focusedTarget, "remove");
				}
				return;
			}

			switch (action.kind) {
				case "next":
					e.preventDefault();
					setIndex((i) => moveFocus(i, 1, live.length));
					setRevealed(false);
					break;
				case "prev":
					e.preventDefault();
					setIndex((i) => moveFocus(i, -1, live.length));
					setRevealed(false);
					break;
				case "dismiss":
					if (focusedTarget) void resolve(focusedTarget, "dismiss");
					break;
				case "remove":
					if (focusedTarget) setPending(needsConfirm("remove") ? "remove" : null);
					break;
				case "undo":
					void undo();
					break;
				case "toggleExcerpt":
					setRevealed((r) => !r);
					break;
				case "switchChamber":
					// The kefil chamber is a downstream slice; Tab is bound but inert here so
					// the rhythm is learnable now and the switch lands when #1704 ships.
					e.preventDefault();
					break;
				case "escape": {
					e.preventDefault();
					const layer: LoopLayer = revealed ? "selection" : "grid";
					if (escapeTo(layer) === "grid") onExit();
					else setRevealed(false);
					break;
				}
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [
		busy,
		pending,
		focusedTarget,
		live.length,
		revealed,
		resolve,
		undo,
		onExit,
		waveOpen,
		focusedData?.authorId,
	]);

	if (live.length === 0) {
		const drained = drainedLabel(decisionsToday);
		return (
			<div className="kp-triage__drained" data-testid="triage-drained">
				<p className="kp-triage__drained-line">{t(drained.key, drained.params)}</p>
			</div>
		);
	}

	return (
		<div className="kp-triage" data-testid="triage-loop">
			<div className="kp-triage__hud" aria-hidden="true">
				<span className="kp-triage__pos">
					{Math.min(index, live.length - 1) + 1} / {live.length}
				</span>
				<ul className="kp-triage__legend">
					{triageLegend.map((entry) => (
						<li className="kp-triage__legend-item" key={entry.labelKey}>
							{entry.keys.map((k) => (
								<Kbd key={k}>{k}</Kbd>
							))}
							<span className="kp-triage__legend-label">{t(entry.labelKey)}</span>
						</li>
					))}
				</ul>
			</div>

			<div className="kp-triage__stage" data-drawer={drawerOpen}>
				{focused && <TriageCard node={focused.node} revealed={revealed} />}
				{focused && drawerOpen && (
					<TriageActorDrawer
						node={focused.node}
						chamber={chamber}
						onHopKefil={() => {
							setChamber("kefil");
							setDrawerOpen(true);
						}}
						onHopModeration={() => {
							setChamber("raporlar");
							setDrawerOpen(true);
						}}
					/>
				)}
			</div>

			{error && (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-triage__error"
					data-testid="triage-error"
				>
					{error}
				</Alert>
			)}

			{pending === "remove" && focusedTarget && (
				<div className="kp-triage__confirm" role="alertdialog" data-testid="triage-confirm">
					<p className="kp-triage__confirm-line">{t("divan.triage.confirmLine")}</p>
					<div className="kp-triage__confirm-actions">
						<Button
							type="button"
							variant="danger"
							size="sm"
							className="kp-triage__confirm-yes"
							disabled={busy}
							loading={busy}
							onClick={() => void resolve(focusedTarget, "remove")}
							data-testid="triage-confirm-yes"
						>
							{t("divan.triage.remove")}
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="kp-triage__confirm-no"
							disabled={busy}
							onClick={() => setPending(null)}
							data-testid="triage-confirm-no"
						>
							{t("divan.cancel")}
						</Button>
					</div>
				</div>
			)}

			{waveOpen && focused && (
				<WaveManifest
					rows={live}
					authorId={focusedData?.authorId ?? null}
					resolveTarget={resolveTarget}
					onResolved={onWaveResolved}
					onClose={() => setWaveOpen(false)}
				/>
			)}
		</div>
	);
}

// The remove-the-wave manifest (#1855, ADR 0138): the focused actor's open-reported targets
// off the SAME queue read. It owns the keyboard while open and fans the existing
// single-target `report.resolve` over the selection; the pure decisions live in
// `remove-the-wave.ts`.
function WaveManifest({
	rows,
	authorId,
	resolveTarget,
	onResolved,
	onClose,
}: {
	readonly rows: ReadonlyArray<{readonly node: ViewRef<"OpenReport">}>;
	readonly authorId: string | null;
	readonly resolveTarget: (input: WaveResolveInput, verdict: Verdict) => Promise<boolean>;
	readonly onResolved: (keys: ReadonlyArray<string>, waveId: string) => void;
	readonly onClose: () => void;
}) {
	const t = useT();
	const {locale} = useLocale();
	const [rowsByKey, setRowsByKey] = useState<Record<string, WaveRow>>({});
	const onProbe = useCallback((row: WaveRow) => {
		const key = waveTargetKey(row);
		setRowsByKey((prev) => {
			const cur = prev[key];
			if (
				cur !== undefined &&
				cur.authorId === row.authorId &&
				cur.reportCount === row.reportCount &&
				cur.title === row.title
			) {
				return prev;
			}
			return {...prev, [key]: row};
		});
	}, []);

	const manifest = buildWaveManifest(Object.values(rowsByKey), authorId);

	// Selection stays "auto" (the safe-by-default deselect over whatever has probed) until the
	// mod first touches it, so a late-loading row is auto-included until `T`/`Space` freezes the
	// set to their choice.
	const [explicit, setExplicit] = useState<ReadonlyArray<string> | null>(null);
	const selected = explicit ?? initialWaveSelection(manifest);

	const [index, setIndex] = useState(0);
	const [pending, setPending] = useState<Verdict | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const manifestLabel = waveManifestLabel(manifest.length);
	const blast = blastRadiusLabel(manifest, selected);

	const apply = useCallback(
		async (verdict: Verdict) => {
			const targets = selectedWaveTargets(manifest, selected);
			if (targets.length === 0) return;
			setBusy(true);
			setError(null);
			// ONE grouping id per gesture, threaded through every fanned resolve so the batch reopens as
			// a unit. A target that fails never gets the stamp, so the wave groups only the successes.
			const waveId = crypto.randomUUID();
			const outcomes: WaveOutcome[] = [];
			for (const input of waveResolveInputs(targets, waveId)) {
				const ok = await resolveTarget(input, verdict);
				outcomes.push({key: waveTargetKey(input), ok});
			}
			const {resolved, failed} = summarizeWaveBatch(outcomes);
			onResolved(resolved, waveId);
			setPending(null);
			setBusy(false);
			const failLabel = waveFailureLabel(failed.length);
			if (failLabel !== null) {
				// No silent partial drop: the failed targets stay selected and in the manifest.
				setError(t(failLabel.key, failLabel.params));
				setExplicit(failed);
			} else {
				onClose();
			}
		},
		[manifest, selected, resolveTarget, onResolved, onClose, t],
	);

	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (busy) return;
			if (pending !== null) {
				const confirm = waveConfirmKey(e.key);
				if (confirm === "apply") {
					e.preventDefault();
					void apply("remove");
				} else if (confirm === "cancel") {
					e.preventDefault();
					setPending(null);
				}
				return;
			}
			const wave = waveKeyToAction({key: e.key, code: e.code, altKey: e.altKey});
			if (wave !== null) {
				e.preventDefault();
				switch (wave.kind) {
					case "selectAll":
						setExplicit(selectAllWave(manifest));
						break;
					case "toggleRow": {
						const row = manifest[index];
						if (row) setExplicit(toggleWaveRow(selected, waveTargetKey(row)));
						break;
					}
					case "batchDismiss":
						if (canApplyWave(selected)) void apply("dismiss");
						break;
					case "batchRemove":
						if (canApplyWave(selected)) setPending("remove");
						break;
					case "grab":
						break;
				}
				return;
			}
			const nav = keyToAction(e.key);
			if (nav?.kind === "next") {
				e.preventDefault();
				setIndex((i) => moveFocus(i, 1, manifest.length));
			} else if (nav?.kind === "prev") {
				e.preventDefault();
				setIndex((i) => moveFocus(i, -1, manifest.length));
			} else if (nav?.kind === "escape") {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [busy, pending, manifest, index, selected, apply, onClose]);

	return (
		<Surface
			tone="raised"
			radius="sm"
			padding="lg"
			border
			className="kp-wave"
			role="dialog"
			aria-label={t("divan.wave.label")}
			data-testid="wave-manifest"
		>
			<header className="kp-wave__head">
				<span className="kp-wave__title" data-testid="wave-title">
					{t(manifestLabel.key, manifestLabel.params)}
				</span>
				<span className="kp-wave__keys" aria-hidden="true">
					{t("divan.wave.keys")}
				</span>
			</header>

			<ul className="kp-wave__list">
				{manifest.map((target, i) => {
					const key = waveTargetKey(target);
					const on = isWaveSelected(selected, key);
					return (
						<li
							key={key}
							className="kp-wave__row"
							data-focused={i === Math.min(index, Math.max(0, manifest.length - 1))}
							data-selected={on}
							data-testid={`wave-row-${key}`}
						>
							<span className="kp-wave__check" aria-hidden="true">
								{on ? "◉" : "○"}
							</span>
							<span className="kp-wave__kind">{t(itemKindLabel(target.targetKind))}</span>
							<span className="kp-wave__row-title">{target.title}</span>
							<span className="kp-wave__count">
								{plural(locale, target.reportCount, {
									one: t("divan.report.count.one", {count: target.reportCount}),
									other: t("divan.report.count.other", {count: target.reportCount}),
								})}
							</span>
						</li>
					);
				})}
			</ul>

			{error && (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-wave__error"
					data-testid="wave-error"
				>
					{error}
				</Alert>
			)}

			{pending === "remove" && (
				<div className="kp-wave__confirm" role="alertdialog" data-testid="wave-confirm">
					<p className="kp-wave__confirm-line" data-testid="wave-confirm-line">
						{t(blast.frame.key, {
							...blast.frame.params,
							reports: t(blast.reports.key, blast.reports.params),
						})}
					</p>
					<div className="kp-wave__confirm-actions">
						<Button
							type="button"
							variant="danger"
							size="sm"
							className="kp-wave__confirm-yes"
							disabled={busy}
							loading={busy}
							onClick={() => void apply("remove")}
							data-testid="wave-confirm-yes"
						>
							{t("divan.wave.remove")}
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="kp-wave__confirm-no"
							disabled={busy}
							onClick={() => setPending(null)}
							data-testid="wave-confirm-no"
						>
							{t("divan.wave.cancel")}
						</Button>
					</div>
				</div>
			)}

			{rows.map(({node}) => (
				<WaveProbe key={String(node.id)} node={node} onData={onProbe} />
			))}
		</Surface>
	);
}

// A hidden data-loader: resolves one queue row's actor/report projection and lifts it to the
// manifest, so the parent groups by author without the loop pre-resolving every row.
function WaveProbe({
	node,
	onData,
}: {
	readonly node: ViewRef<"OpenReport">;
	readonly onData: (row: WaveRow) => void;
}) {
	const t = useT();
	const data = useView(OpenReportLoopView, node);
	useEffect(() => {
		onData({
			targetKind: data.targetKind,
			targetId: data.targetId,
			title: targetExcerptText(data.targetExcerpt) ?? t("divan.excerpt.unavailable"),
			reportCount: data.reportCount,
			authorId: data.authorId,
		});
	}, [
		data.targetKind,
		data.targetId,
		data.targetExcerpt,
		data.reportCount,
		data.authorId,
		onData,
		t,
	]);
	return null;
}

// A MODE over the gated row — the drawer's actor projection, no re-fetch.
function TriageActorDrawer({
	node,
	chamber,
	onHopKefil,
	onHopModeration,
}: {
	readonly node: ViewRef<"OpenReport">;
	readonly chamber: Chamber;
	readonly onHopKefil: () => void;
	readonly onHopModeration: () => void;
}) {
	const data = useView(OpenReportLoopView, node);
	return (
		<ActorDrawer
			data={data}
			chamber={chamber}
			onHopKefil={onHopKefil}
			onHopModeration={onHopModeration}
		/>
	);
}

function TriageCard({
	node,
	revealed,
}: {
	readonly node: ViewRef<"OpenReport">;
	readonly revealed: boolean;
}) {
	const t = useT();
	const data = useView(OpenReportLoopView, node);
	const age = reportAgeLabel(data.firstReportedAt, Date.now());
	const href = targetHref(data.targetKind, data.targetRef);
	const masked = maskedExcerpt(data.targetExcerpt, revealed);
	const excerpt = "text" in masked ? masked.text : t(masked.key, masked.params);
	const diversity = reporterDiversityLabel(data.reportCount, data.distinctReporters);
	const reputation = authorReputationLabel(
		data.authorTier,
		data.authorKarma,
		data.authorPriorRemovals,
	);
	const reason = reasonText(data.reason) ?? t("divan.rapor.noReason");

	return (
		<Surface
			as="article"
			tone="raised"
			radius="sm"
			padding="lg"
			border
			className="kp-triage__card"
			data-testid={`triage-card-${data.targetKind}-${data.targetId}`}
		>
			<header className="kp-triage__card-head">
				<span className="kp-triage__kind">{t(itemKindLabel(data.targetKind))}</span>
				<Badge variant="secondary" className="kp-triage__diversity" data-testid="triage-diversity">
					{t(diversity.key, diversity.params)}
				</Badge>
				{age !== null && <span className="kp-triage__age">{t(age.key, age.params)}</span>}
			</header>

			<div className="kp-triage__excerpt-wrap">
				{href !== null && revealed ? (
					<a className="kp-triage__excerpt-link" href={href}>
						{excerpt}
					</a>
				) : (
					<p className="kp-triage__excerpt" data-revealed={revealed}>
						{excerpt}
					</p>
				)}
			</div>

			<footer className="kp-triage__card-foot">
				{data.targetAuthor !== null && (
					<span className="kp-triage__author">@{data.targetAuthor}</span>
				)}
				{reputation !== null && (
					<span className="kp-triage__reputation" data-testid="triage-reputation">
						{t(reputation.key, reputation.params)}
					</span>
				)}
				<span className="kp-triage__reason">{reason}</span>
			</footer>
		</Surface>
	);
}
