/**
 * `TriageLoop` — the moderation triage-loop hero (#1703, ADR 0138): a single-item,
 * keyboard-driven review over the SAME `Moderate`-gated `report.listOpen` read the
 * grid (`Raporlar`, #1701) consumes — a MODE, not a re-fetch. One reported target is
 * central at a time; the moderator's hands stay on the keyboard (`j/k` gez, `Y`
 * yoksay, `R` kaldır + confirm, `U` geri al, `O` göster, `Tab` oda, `Esc` çık). Each
 * target carries its reputation-in-row (author standing + the pile-on's reporter
 * diversity), the #1852 actor-drawer seam threaded now.
 *
 * Verdicts wire to the existing `report.resolve` mutation (plain round-trip, no
 * optimistic UI): `Y` dismisses in one keystroke; `R` opens a confirm because remove
 * hides content. A failed resolve surfaces an error and leaves the row actionable —
 * never a silent drop. The pure focus / verdict-key / confirm / Esc-ladder / copy
 * decisions live DOM-free in `triageLoop.ts` (unit-tested); this component is the thin
 * React shell over them.
 */
import {useCallback, useEffect, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {OpenReport, ResolveReceipt} from "../../../worker/features/report/views";
import {ActorDrawer} from "./ActorDrawer";
import {type Chamber, drawerDefaultOpen, drawerKeyToAction, hopTarget} from "./actor-drawer";
import {itemKindLabel, parseBacklogItemId} from "./divanGating";
import {reasonLabel, reportAgeLabel, targetExcerptLabel, targetHref} from "./raporlarGating";
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

// The `report.resolve` / `report.restore` acks (ADR 0098) — a client-side selection
// over the result-only `ResolveReceipt`. The loop doesn't render the ack (plain
// round-trip, no optimistic UI); it's requested to satisfy the mutation's view param.
const ResolveReceiptView = view<ResolveReceipt>()({
	id: true,
	targetKind: true,
	targetId: true,
	resolution: true,
	targetRemoved: true,
	collapsed: true,
});

/**
 * The last decision the loop can undo (`U`): a single-target verdict, or a wave-removal
 * batch (#1855). `U` restores the batch as a unit (`report.restoreWave`) when the last
 * decision was a wave, mirroring the decision feed's wave-restore.
 */
type LastVerdict =
	| {
			readonly kind: "single";
			readonly targetKind: OpenReport["targetKind"];
			readonly targetId: string;
			readonly verdict: Verdict;
	  }
	| {readonly kind: "wave"; readonly waveId: string; readonly keys: ReadonlyArray<string>};

export function TriageLoop({onExit}: {readonly onExit: () => void}) {
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

	// The actor-drawer (#1852, ADR 0138): the focused item's actor, docked open by
	// default on desktop (founder call). `chamber` is which mode it was entered from —
	// `raporlar` here, `kefil` after a `V` hop; the hop only re-lenses the SAME actor,
	// it never re-fetches. Desktop is a coarse pointer + wide viewport (no docked panel
	// on a phone-sized surface).
	const isDesktop =
		typeof window !== "undefined" && window.matchMedia?.("(min-width: 900px)").matches === true;
	const [drawerOpen, setDrawerOpen] = useState(() => drawerDefaultOpen(isDesktop));
	const [chamber, setChamber] = useState<Chamber>("raporlar");

	// The resolved-target ids the loop has already acted on this session — used to
	// present the post-collapse queue without a re-fetch (a MODE over the same read).
	const [resolvedIds, setResolvedIds] = useState<ReadonlyArray<string>>([]);
	const live = items.filter(({node}) => !resolvedIds.includes(String(node.id)));

	const focused = live[Math.min(index, Math.max(0, live.length - 1))] ?? null;
	// The row's identity is its `<kind>:<id>` view id (the same key `report.resolve`
	// takes), parsed off the ref without resolving the whole entity — the loop acts on
	// the focused target's identity, not its rendered fields.
	const focusedTarget = focused ? parseBacklogItemId(String(focused.node.id)) : null;

	// The focused row's actor id — the join key `Shift-X` grabs a wave for (#1855). The
	// null-tolerant `useView` subscribes to the focused ref only (the manifest's other
	// rows load lazily behind the flag, inside `WaveManifest` when it opens).
	const focusedData = useView(OpenReportLoopView, focused?.node ?? null);
	// remove-the-wave (#1855): `Shift-X` opens the same-author batch manifest over the
	// SAME queue read; the manifest owns the keyboard while open (the loop's own handler
	// yields to it). Dark behind `phoenix-mod-queue` with the rest of `/divan`.
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
					setError("işlem başarısız oldu, tekrar dene.");
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
				setError("işlem başarısız oldu, tekrar dene.");
			} finally {
				setBusy(false);
			}
		},
		[fate, live.length],
	);

	const undo = useCallback(async () => {
		const last = lastVerdict;
		if (!last) return;
		setBusy(true);
		setError(null);
		try {
			// Undo is the existing restore/reopen edge (ADR 0098 §3): a removed target comes
			// back live and its reports reopen; a dismissed group reopens the same way. A
			// wave-removal (#1855) undoes as a UNIT — `report.restoreWave` reopens the whole
			// batch — so `U` mirrors the decision feed's wave-restore; a lone verdict is the
			// single-target restore. Either path rehydrates the affected rows into the queue.
			if (last.kind === "wave") {
				const {error: callError} = await fate.mutations.report.restoreWave({
					input: {waveId: last.waveId},
					view: ResolveReceiptView,
				});
				if (callError) {
					setError("geri alınamadı, tekrar dene.");
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
					setError("geri alınamadı, tekrar dene.");
					return;
				}
				const id = `${last.targetKind}:${last.targetId}`;
				setResolvedIds((prev) => prev.filter((x) => x !== id));
				setDecisionsToday((n) => Math.max(0, n - 1));
			}
			setLastVerdict(null);
		} catch {
			setError("geri alınamadı, tekrar dene.");
		} finally {
			setBusy(false);
		}
	}, [fate, lastVerdict]);

	// One target's batch resolve (#1855): the SAME single-target `report.resolve` the
	// loop uses, fanned over the wave selection with the gesture's shared `waveId` so the
	// batch reopens as a unit. Returns whether it landed so the batch can partition
	// resolved from failed (no silent partial drop).
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

	// A batch collapsed these keys off the queue — mirror the single-verdict bookkeeping
	// (drop them from the live queue, count each decision) without a re-fetch, and record the
	// wave as the last verdict so `U` undoes the whole batch as a unit (#1855).
	const onWaveResolved = useCallback((keys: ReadonlyArray<string>, waveId: string) => {
		if (keys.length === 0) return;
		setResolvedIds((prev) => [...prev, ...keys]);
		setDecisionsToday((n) => n + keys.length);
		setLastVerdict({kind: "wave", waveId, keys});
	}, []);

	// The one keyboard listener the whole loop is driven by. The pure `keyToAction`
	// maps the raw key; the switch runs the effect. `Tab`/`Escape` are prevented from
	// their default so the loop owns them while it's the active surface.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (busy) return;
			// While the wave manifest is open it owns the keyboard entirely (#1855) — its
			// own listener handles select/toggle/batch/close, so the loop stands down.
			if (waveOpen) return;

			// `Shift-X` grabs the focused target's author into the wave manifest (#1855) —
			// only when the actor resolves (an anonymized row has no author to group).
			if (pending === null) {
				const wave = waveKeyToAction({key: e.key, code: e.code, altKey: e.altKey});
				if (wave?.kind === "grab") {
					e.preventDefault();
					if (focusedData?.authorId != null) setWaveOpen(true);
					return;
				}
			}

			// The actor-drawer bindings (#1852) take precedence over the loop's own, but
			// only outside a confirm sheet (a sheet narrows to its own keys). `A` toggles
			// the drawer; `V`/`M` hop between the kefil and moderation chambers on the SAME
			// actor — a re-lens, not a re-fetch.
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

			// A confirm sheet narrows the bindings: only the verdict's confirm/cancel.
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
					// Asymmetric weight: remove opens the confirm sheet, never commits directly.
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
		return (
			<div className="kp-triage__drained" data-testid="triage-drained">
				<p className="kp-triage__drained-line">{drainedLabel(decisionsToday)}</p>
			</div>
		);
	}

	return (
		<div className="kp-triage" data-testid="triage-loop">
			<div className="kp-triage__hud" aria-hidden="true">
				<span>
					{Math.min(index, live.length - 1) + 1} / {live.length}
				</span>
				<span className="kp-triage__keys">
					j/k gez · Y yoksay · R kaldır · U geri al · O göster · A künye · V/M oda · X dalga
				</span>
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
				<p className="kp-triage__error" role="alert" data-testid="triage-error">
					{error}
				</p>
			)}

			{pending === "remove" && focusedTarget && (
				<div className="kp-triage__confirm" role="alertdialog" data-testid="triage-confirm">
					<p className="kp-triage__confirm-line">içeriği kaldır? (R onayla · Esc vazgeç)</p>
					<div className="kp-triage__confirm-actions">
						<button
							type="button"
							className="kp-triage__confirm-yes"
							disabled={busy}
							onClick={() => void resolve(focusedTarget, "remove")}
							data-testid="triage-confirm-yes"
						>
							kaldır
						</button>
						<button
							type="button"
							className="kp-triage__confirm-no"
							disabled={busy}
							onClick={() => setPending(null)}
							data-testid="triage-confirm-no"
						>
							vazgeç
						</button>
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

// The remove-the-wave manifest (#1855, ADR 0138): the focused actor's open-reported
// targets, grabbed off the SAME queue read (a MODE, never a re-fetch). It owns the
// keyboard while open — `T` tümü, `Space` seç, `⌥R` kaldır (blast-radius confirm), `⌥Y`
// yoksay, `j/k` gez, `Esc` çık — and fans the existing single-target `report.resolve`
// over the selection, partitioning resolved from failed so a partial failure stays
// actionable. Each queue row lazily resolves its actor/report projection via a
// `WaveProbe`; the pure grouping/selection/blast-radius decisions live in
// `remove-the-wave.ts` (unit-tested).
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

	// Selection stays "auto" (the safe-by-default auto-deselect over whatever has probed)
	// until the mod first touches it, then it's their explicit set. This tracks
	// incremental probe arrival correctly: a late-loading row is auto-included until a
	// `T`/`Space` freezes the selection to the moderator's choice.
	const [explicit, setExplicit] = useState<ReadonlyArray<string> | null>(null);
	const selected = explicit ?? initialWaveSelection(manifest);

	const [index, setIndex] = useState(0);
	const [pending, setPending] = useState<Verdict | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const apply = useCallback(
		async (verdict: Verdict) => {
			const targets = selectedWaveTargets(manifest, selected);
			if (targets.length === 0) return;
			setBusy(true);
			setError(null);
			// ONE grouping id per gesture, threaded through every fanned-out resolve so the
			// batch reopens as a unit (#1855). A target that fails to resolve simply never
			// gets the stamp (its write didn't land), so the wave groups only the successes.
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
				// No silent partial drop: keep the failed targets selected + in the manifest
				// so they stay actionable, and name how many didn't resolve.
				setError(failLabel);
				setExplicit(failed);
			} else {
				onClose();
			}
		},
		[manifest, selected, resolveTarget, onResolved, onClose],
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
						// Asymmetric weight (like the single verdict): remove opens the
						// blast-radius confirm, dismiss commits directly.
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
		<div className="kp-wave" role="dialog" aria-label="dalgayı kaldır" data-testid="wave-manifest">
			<header className="kp-wave__head">
				<span className="kp-wave__title" data-testid="wave-title">
					{waveManifestLabel(manifest.length)}
				</span>
				<span className="kp-wave__keys" aria-hidden="true">
					T tümü · Space seç · ⌥R kaldır · ⌥Y yoksay · Esc çık
				</span>
			</header>

			<ul className="kp-wave__list">
				{manifest.map((t, i) => {
					const key = waveTargetKey(t);
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
							<span className="kp-wave__kind">{itemKindLabel(t.targetKind)}</span>
							<span className="kp-wave__row-title">{t.title}</span>
							<span className="kp-wave__count">{t.reportCount} rapor</span>
						</li>
					);
				})}
			</ul>

			{error && (
				<p className="kp-wave__error" role="alert" data-testid="wave-error">
					{error}
				</p>
			)}

			{pending === "remove" && (
				<div className="kp-wave__confirm" role="alertdialog" data-testid="wave-confirm">
					<p className="kp-wave__confirm-line" data-testid="wave-confirm-line">
						{blastRadiusLabel(manifest, selected)}
					</p>
					<div className="kp-wave__confirm-actions">
						<button
							type="button"
							className="kp-wave__confirm-yes"
							disabled={busy}
							onClick={() => void apply("remove")}
							data-testid="wave-confirm-yes"
						>
							kaldır (Enter)
						</button>
						<button
							type="button"
							className="kp-wave__confirm-no"
							disabled={busy}
							onClick={() => setPending(null)}
							data-testid="wave-confirm-no"
						>
							vazgeç (Esc)
						</button>
					</div>
				</div>
			)}

			{rows.map(({node}) => (
				<WaveProbe key={String(node.id)} node={node} onData={onProbe} />
			))}
		</div>
	);
}

// A hidden data-loader: resolves one queue row's actor/report projection off the shared
// gated read and lifts it to the manifest, so the parent can group by author + sum the
// blast radius without the loop pre-resolving every row.
function WaveProbe({
	node,
	onData,
}: {
	readonly node: ViewRef<"OpenReport">;
	readonly onData: (row: WaveRow) => void;
}) {
	const data = useView(OpenReportLoopView, node);
	useEffect(() => {
		onData({
			targetKind: data.targetKind,
			targetId: data.targetId,
			title: targetExcerptLabel(data.targetExcerpt),
			reportCount: data.reportCount,
			authorId: data.authorId,
		});
	}, [data.targetKind, data.targetId, data.targetExcerpt, data.reportCount, data.authorId, onData]);
	return null;
}

// Resolve the focused node's full `OpenReport` view (the same read the card renders off)
// and hand its actor projection to the drawer — a MODE over the gated row, no re-fetch.
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
	const data = useView(OpenReportLoopView, node);
	const age = reportAgeLabel(data.firstReportedAt, Date.now());
	const href = targetHref(data.targetKind, data.targetRef);
	const excerpt = maskedExcerpt(data.targetExcerpt, revealed);
	const diversity = reporterDiversityLabel(data.reportCount, data.distinctReporters);
	const reputation = authorReputationLabel(
		data.authorTier,
		data.authorKarma,
		data.authorPriorRemovals,
	);

	return (
		<article
			className="kp-triage__card"
			data-testid={`triage-card-${data.targetKind}-${data.targetId}`}
		>
			<header className="kp-triage__card-head">
				<span className="kp-triage__kind">{itemKindLabel(data.targetKind)}</span>
				<span className="kp-triage__diversity" data-testid="triage-diversity">
					{diversity}
				</span>
				{age !== null && <span className="kp-triage__age">{age}</span>}
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
						{reputation}
					</span>
				)}
				<span className="kp-triage__reason">{reasonLabel(data.reason)}</span>
			</footer>
		</article>
	);
}
