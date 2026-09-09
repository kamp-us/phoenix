/**
 * The desk, attached. Everything below the socket is `../shell/ui/`'s; what this component adds is
 * the wiring the surface deliberately does not own — which process each window is showing, and the
 * one subscription per process behind it.
 *
 * **One process, one subscription.** Two windows over one process share the `AttachedProcess` this
 * component opened, which is what makes them one state with two view slots rather than two copies
 * of a process (#7484 R1.3).
 *
 * **The page holds no desk state.** Workspaces, layout, focus and view slots all come from the
 * snapshot and go back as Msgs; the two maps here mirror the wire and die with the socket (#7556).
 *
 * **The link is replaced, this component is not.** `./connection.ts` hands a fresh `page` and
 * `shell` in as props when it re-attaches; the desk, the key grammar and the window subscriptions
 * are rebuilt around them in place, so a founder keeps looking at the last snapshot through the gap
 * instead of a blank tab (#8004).
 */

import {Effect, Fiber, Option, Stream} from "effect";
import type {ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {ProcessId} from "../process/process.ts";
import type {ProgramId} from "../registry/program.ts";
import {ProcessBoard} from "../shell/board/index.ts";
import type {ShellMsg, ShellState} from "../shell/core/index.ts";
import {openProcessMsg} from "../shell/core/machine.ts";
import type {
	AnyInspectorRenderer,
	AnyStatusRenderer,
	DeclaredRenderers,
	SnapshotProcess,
} from "../shell/desk/index.ts";
import {windows} from "../shell/layout/index.ts";
import type {PickerEntries} from "../shell/picker/browser.ts";
import type {AttachedProcess, PageAttachment, WireProgram} from "../shell/transport/browser.ts";
import type {
	AttachEvent,
	AttachStatus,
	DeskSource,
	DeskTables,
	KeyPress,
	MountResolver,
} from "../shell/ui/index.ts";
import {boundMount, Desk, noRenderer, replyOf, useDeskAttachment} from "../shell/ui/index.ts";
import type {RendererTable} from "../shell/window/index.ts";
import {empty, processGone, resolverFromTable, type ViewState} from "../shell/window/index.ts";
import type {TableRow} from "../table/row.ts";
import {useSpellRegistry} from "./spell-registry.ts";

export interface AttachedDeskProps {
	readonly page: PageAttachment;
	readonly shell: AttachedProcess<unknown, ShellMsg>;
	/**
	 * One renderer per `RendererRef.ref` — `./renderers.tsx` says why the key is the reference — or,
	 * for a module reference the page could not load, the failure in its seat (`./module-renderers.ts`).
	 */
	readonly renderers: RendererTable;
	/**
	 * The two desk-level renderer tables, keyed the same way. Both default to empty: a page that
	 * mounts no program's inspector still gets the region, showing why it is empty.
	 */
	readonly inspectors?: Readonly<Record<string, AnyInspectorRenderer>>;
	readonly statuses?: Readonly<Record<string, AnyStatusRenderer>>;
	readonly reducedMotion: boolean;
	/**
	 * Draw the process board over the desk — the page's half of `features.processBoard`
	 * (`../features.ts`), off by default. Off, this component renders exactly the tree it rendered
	 * before the flag existed: no board, and no wrapper around the desk (#8723).
	 */
	readonly board?: boolean;
	/**
	 * Why the page stopped re-attaching, if it has. Set means the desk below is frozen for good and
	 * says so; `null` means the lifecycle is still working, whatever the socket is doing right now.
	 */
	readonly refusal: string | null;
	/**
	 * The operator's `windowTitles` flag (`../features.ts`, #8721), read off the generated module at
	 * the page's root (`./boot.tsx`) and handed down rather than imported here, so a test renders
	 * this component at either setting without a bundler in the way.
	 */
	readonly windowTitles?: boolean;
}

/**
 * What the desk under it is worth right now. It sits over the desk rather than replacing it: the
 * retained snapshot is still the most useful thing on screen, and the one thing a founder must not
 * do is read it as current (#8004).
 */
const ConnectionBanner = ({
	status,
	reason,
	refusal,
}: {
	readonly status: AttachStatus;
	readonly reason: string | null;
	readonly refusal: string | null;
}) => {
	if (refusal !== null) {
		return (
			<p className="tuval-connection tuval-connection-refused" role="alert" aria-label="Connection">
				<strong>Disconnected.</strong> This desk is the last state the kernel sent and it has
				stopped updating: {refusal}
			</p>
		);
	}
	if (status !== "reattaching") return null;
	return (
		<p className="tuval-connection" role="status" aria-label="Connection">
			<strong>Reconnecting…</strong> This desk is the last state the kernel sent and it is not
			updating{reason === null ? "" : ` (${reason})`}.
		</p>
	);
};

/** Every process id the desk currently shows in a window, across every workspace. */
const shownProcesses = (state: ShellState): ReadonlySet<string> => {
	const shown = new Set<string>();
	for (const workspaceId of state.order) {
		const workspace = state.workspaces[workspaceId];
		if (workspace === undefined) continue;
		for (const window of windows(workspace.layout.root)) {
			if (window.processId !== null) shown.add(window.processId);
		}
	}
	return shown;
};

/**
 * What the picker can offer this page: the kernel's windowed programs as they arrived on the
 * registry frame, and the processes already running. The headless test is not repeated here — a row
 * that cannot fill a window never crosses the wire (`../shell/transport/server.ts`).
 */
const entriesFrom = (
	rows: ReadonlyMap<ProcessId, TableRow>,
	catalog: ReadonlyMap<ProgramId, WireProgram>,
): PickerEntries => ({
	programs: [...catalog.values()].map((program) => ({
		_tag: "Program" as const,
		programId: program.programId,
		label: program.label,
	})),
	processes: [...rows.values()].map((row) => ({
		_tag: "Process" as const,
		processId: row.id,
		programId: row.programId,
		label: row.programId,
		parentId: row.parentId._tag === "Some" ? row.parentId.value : null,
	})),
});

const EMPTY_RENDERERS: Readonly<Record<string, never>> = {};

export function AttachedDesk({
	page,
	shell,
	renderers,
	inspectors = EMPTY_RENDERERS,
	statuses = EMPTY_RENDERERS,
	reducedMotion,
	board = false,
	refusal,
	windowTitles = false,
}: AttachedDeskProps): ReactElement {
	const spells = useSpellRegistry(page);
	const [rows, setRows] = useState<ReadonlyMap<ProcessId, TableRow>>(new Map());
	const [catalog, setCatalog] = useState<ReadonlyMap<ProgramId, WireProgram>>(new Map());
	const [attached, setAttached] = useState<ReadonlyMap<string, AttachedProcess>>(new Map());
	/** The shell process's own revision — the bar's `rev`, read off the same view the snapshot is. */
	const [revision, setRevision] = useState(0);
	/** Ids an attach has already been started for; a second window must not open a second socket read. */
	const asked = useRef(new Set<string>());
	/**
	 * The newest shell revision this page has shown, whichever carrier brought it. `null` is "nothing
	 * seen yet" and is not a revision: a fresh kernel's shell sits at revision 0 until something
	 * commits a row (`../process/Processes.ts`), so a zero sentinel would drop that first snapshot
	 * and leave the desk on its placeholder.
	 */
	const seen = useRef<number | null>(null);
	/** How a snapshot reaches the desk. Set while the attachment's source is subscribed. */
	const deliver = useRef<((revision: number, state: unknown) => void) | null>(null);
	/**
	 * This page's stamp on a key press. One prefix per mounted desk plus a counter, because the id
	 * has to distinguish *this* page's press from a second page's on the same shell (#8274) — the
	 * kernel echoes it back on `lastPress` and the page reads an answer only under its own.
	 */
	const pressMark = useRef(`${Math.random().toString(36).slice(2)}`);
	const pressCount = useRef(0);

	const source = useCallback<DeskSource>(
		(emit) => {
			emit({_tag: "Attached"} satisfies AttachEvent);
			deliver.current = (revision, state) => {
				// Newest wins, by the kernel's own revision. The two carriers of a snapshot — the state
				// pump and the acknowledgement for this page's own dispatch — run on different fibers
				// and nothing orders them, so the desk takes whichever is newer and ignores the other
				// (#8274). Monotone and self-correcting: nothing here is a copy that can drift.
				if (seen.current !== null && revision <= seen.current) return;
				seen.current = revision;
				setRevision(revision);
				emit({_tag: "Snapshot", state} satisfies AttachEvent);
			};
			const snapshots = Effect.runFork(
				Stream.runForEach(shell.readProcess, (view) =>
					Effect.sync(() => {
						if (view._tag === "Live") deliver.current?.(view.revision, view.state);
						else emit({_tag: "Dropped", reason: "the shell process is gone"} satisfies AttachEvent);
					}),
				),
			);
			// The grammar rides the same machine as the snapshot, so a drop keeps both (ADR 0353).
			const keys = Effect.runFork(
				Stream.runForEach(page.keys, (table) =>
					Effect.sync(() => emit({_tag: "Keys", table} satisfies AttachEvent)),
				),
			);
			// The socket ending is the drop the machine folds. `readProcess` cannot report it — a
			// `SubscriptionRef` that stops being written to just goes quiet — so the drop is read off
			// the socket itself (`../shell/transport/client.ts`).
			const lost = Effect.runFork(
				Effect.flatMap(page.closed, (error) =>
					Effect.sync(() => emit({_tag: "Dropped", reason: error.message} satisfies AttachEvent)),
				),
			);
			return () => {
				deliver.current = null;
				Effect.runFork(Fiber.interrupt(snapshots));
				Effect.runFork(Fiber.interrupt(keys));
				Effect.runFork(Fiber.interrupt(lost));
			};
		},
		[shell, page],
	);
	const attachment = useDeskAttachment(source);
	const desk = attachment.desk;

	// A fresh socket makes every held `AttachedProcess` a handle on one that is gone, and every id in
	// `asked` a claim about a subscription that no longer exists. Dropping both is what makes the
	// effect below re-open one subscription per shown process instead of adding to a stale set.
	useEffect(() => {
		asked.current = new Set();
		setAttached(new Map());
		// A fresh socket may be a fresh kernel, whose revisions start again from the bottom. Holding
		// the old high-water mark would make the desk ignore every snapshot the new one sends.
		seen.current = null;
	}, [page]);

	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(page.rows, (next) =>
				Effect.sync(() => setRows(new Map(next.map((row) => [row.id, row])))),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [page]);

	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(page.programs, (next) =>
				Effect.sync(() => setCatalog(new Map(next.map((program) => [program.programId, program])))),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [page]);

	useEffect(() => {
		if (desk === null) return;
		for (const processId of shownProcesses(desk)) {
			if (asked.current.has(processId)) continue;
			asked.current.add(processId);
			Effect.runFork(
				page.attachProcess(processId as ProcessId).pipe(
					Effect.tap((process) =>
						Effect.sync(() => setAttached((held) => new Map(held).set(processId, process))),
					),
					// A refusal leaves the window on its `ProcessGone` placeholder, which is the honest
					// picture: the page cannot show a process this kernel will not stream.
					Effect.catchCause(() => Effect.sync(() => asked.current.delete(processId))),
				),
			);
		}
	}, [desk, page]);

	const dispatch = useCallback(
		(msg: ShellMsg) => void Effect.runFork(shell.dispatch(msg)),
		[shell],
	);

	// The one key path: send the key, take the kernel's answer off the acknowledgement, and hand the
	// desk both — the answer to act on and the state it left behind (#8274). A dispatch the socket
	// dropped answers `ProcessGone`, which reads as `Refused`: nothing is forwarded, and there is no
	// second copy of the prefix on this page to be left out of step.
	const press = useCallback<KeyPress>(
		(key) => {
			pressCount.current += 1;
			const pressId = `${pressMark.current}-${pressCount.current}`;
			return Effect.runPromise(
				shell.dispatch({type: "keys.press", key, pressId}).pipe(
					Effect.map((result) => {
						if (result._tag === "Delivered" && result.view !== undefined) {
							deliver.current?.(result.view.revision, result.view.state);
						}
						return replyOf(pressId, result);
					}),
				),
			);
		},
		[shell],
	);

	const views = desk?.views ?? {};
	const resolveRenderer = useMemo(() => resolverFromTable(renderers), [renderers]);
	const resolveMount = useCallback<MountResolver>(
		(windowId, processId) => {
			if (processId === null) return empty;
			const id = processId as ProcessId;
			const row = rows.get(id);
			const process = attached.get(processId);
			if (row === undefined || process === undefined) return processGone(id);
			// The row is the whole title (#8721): the newest `title@1` line the kernel latched, and the
			// program that published it. The flag off is `null`, which is the desk that names its
			// windows by uuid.
			const name = windowTitles
				? {title: Option.getOrNull(row.title), programId: row.programId}
				: null;
			const program = catalog.get(row.programId);
			if (program === undefined) {
				// Not "declares no renderer": a miss is also what an empty catalog looks like, and both
				// `rows` and `programs` replay their initial value, so a page can render once before the
				// registry frame lands. The honest sentence names this page's own catalog, not the kernel's.
				return noRenderer(id, `no catalog entry on this page for program ${row.programId}`, name);
			}
			const resolved = resolveRenderer(program.renderer);
			if (resolved._tag === "RendererUnresolved" && resolved.reason === "module-load-failed") {
				return noRenderer(
					id,
					`this page could not load a renderer module: ${resolved.detail}`,
					name,
				);
			}
			if (resolved._tag !== "Resolved") {
				return noRenderer(
					id,
					`this page answers to no renderer named ${program.renderer.ref}`,
					name,
				);
			}
			return boundMount(
				{
					windowId,
					processId: id,
					readProcess: process.readProcess,
					dispatch: process.dispatch,
					view: () => views[windowId] ?? null,
					setView: (next: ViewState) =>
						Effect.sync(() => dispatch({type: "window.setView", windowId, view: next})),
				},
				resolved.renderer.render,
				name,
			);
		},
		[rows, attached, catalog, resolveRenderer, views, dispatch, windowTitles],
	);

	const entries = useMemo(() => entriesFrom(rows, catalog), [rows, catalog]);

	// The board's own two operands. The rows are re-listed rather than handed the map's iterator: an
	// iterator is a fresh object on every render, and the board memoizes its tile model on this value.
	const boardRows = useMemo(() => [...rows.values()], [rows]);
	const openProcess = useCallback(
		(processId: ProcessId) => dispatch(openProcessMsg(processId)),
		[dispatch],
	);

	// The half of a `DeskSnapshot` the shell state does not carry. Everything here is already on the
	// page for the windows' sake; this is the same two frames read for the desk's own regions.
	const deskTables = useMemo<DeskTables>(() => {
		const processes: Record<string, SnapshotProcess> = {};
		for (const row of rows.values()) processes[row.id] = {programId: row.programId};
		const programs: Record<string, DeclaredRenderers> = {};
		for (const program of catalog.values()) {
			programs[program.programId] = {
				...(program.inspector === undefined ? {} : {inspector: program.inspector}),
				...(program.status === undefined ? {} : {status: program.status}),
			};
		}
		return {kernel: {processes: rows.size, revision}, processes, programs, inspectors, statuses};
	}, [rows, catalog, revision, inspectors, statuses]);

	// The grammar gates the desk beside the snapshot: a surface routing keys over a table nobody sent
	// it is the thing ADR 0353 took away, so it waits for one exactly as it waits for a desk.
	if (desk === null || attachment.table === null) {
		return (
			<div className="tuval-surface" data-scheme="dark">
				<p className="tuval-placeholder" role={refusal === null ? "status" : "alert"}>
					{refusal ??
						(attachment.status === "reattaching"
							? "The connection dropped. Attaching again…"
							: "Attaching to the Tuval kernel…")}
				</p>
			</div>
		);
	}

	const deskElement = (
		<Desk
			state={desk}
			dispatch={dispatch}
			press={press}
			resolveMount={resolveMount}
			entries={entries}
			table={attachment.table}
			deskTables={deskTables}
			reducedMotion={reducedMotion}
			call={page.call}
			registry={spells}
			commandsConnected={attachment.status === "attached" && refusal === null}
			windowTitles={windowTitles}
		/>
	);

	return (
		<>
			<ConnectionBanner status={attachment.status} reason={attachment.lastDrop} refusal={refusal} />
			{board ? (
				// The desk is `block-size: 100%` of this column, so it is the item that gives the board
				// its room back (`../shell/board/board.css`). Flag off, there is no wrapper at all and
				// the page is the tree it was before the board existed.
				<div className="tuval-surface tuval-board-page" data-scheme="dark">
					<ProcessBoard rows={boardRows} onOpen={openProcess} reducedMotion={reducedMotion} />
					{deskElement}
				</div>
			) : (
				deskElement
			)}
		</>
	);
}
