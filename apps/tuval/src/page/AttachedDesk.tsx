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
 */

import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {ProcessId} from "../process/process.ts";
import type {ProgramId} from "../registry/program.ts";
import type {ShellMsg, ShellState} from "../shell/core/index.ts";
import {windows} from "../shell/layout/index.ts";
import type {PickerEntries} from "../shell/picker/browser.ts";
import type {AttachedProcess, PageAttachment, WireProgram} from "../shell/transport/browser.ts";
import type {AttachEvent, DeskSource, MountResolver} from "../shell/ui/index.ts";
import {boundMount, Desk, noRenderer, useDeskAttachment} from "../shell/ui/index.ts";
import type {AnyWindowRenderer} from "../shell/window/index.ts";
import {empty, processGone, resolverFromTable, type ViewState} from "../shell/window/index.ts";
import type {TableRow} from "../table/row.ts";

export interface AttachedDeskProps {
	readonly page: PageAttachment;
	readonly shell: AttachedProcess<unknown, ShellMsg>;
	/** One renderer per `RendererRef.ref` — `./renderers.tsx` says why the key is the reference. */
	readonly renderers: Readonly<Record<string, AnyWindowRenderer>>;
	readonly reducedMotion: boolean;
}

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

export function AttachedDesk({
	page,
	shell,
	renderers,
	reducedMotion,
}: AttachedDeskProps): ReactElement {
	const [rows, setRows] = useState<ReadonlyMap<ProcessId, TableRow>>(new Map());
	const [catalog, setCatalog] = useState<ReadonlyMap<ProgramId, WireProgram>>(new Map());
	const [attached, setAttached] = useState<ReadonlyMap<string, AttachedProcess>>(new Map());
	/** Ids an attach has already been started for; a second window must not open a second socket read. */
	const asked = useRef(new Set<string>());

	const source = useCallback<DeskSource>(
		(emit) => {
			emit({_tag: "Attached"} satisfies AttachEvent);
			const snapshots = Effect.runFork(
				Stream.runForEach(shell.readProcess, (view) =>
					Effect.sync(() =>
						emit(
							view._tag === "Live"
								? {_tag: "Snapshot", state: view.state}
								: {_tag: "Dropped", reason: "the shell process is gone"},
						),
					),
				),
			);
			// The grammar rides the same machine as the snapshot, so a drop keeps both (ADR 0353).
			const keys = Effect.runFork(
				Stream.runForEach(page.keys, (table) =>
					Effect.sync(() => emit({_tag: "Keys", table} satisfies AttachEvent)),
				),
			);
			return () => {
				Effect.runFork(Fiber.interrupt(snapshots));
				Effect.runFork(Fiber.interrupt(keys));
			};
		},
		[shell, page],
	);
	const attachment = useDeskAttachment(source);
	const desk = attachment.desk;

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

	const views = desk?.views ?? {};
	const resolveRenderer = useMemo(() => resolverFromTable(renderers), [renderers]);
	const resolveMount = useCallback<MountResolver>(
		(windowId, processId) => {
			if (processId === null) return empty;
			const id = processId as ProcessId;
			const row = rows.get(id);
			const process = attached.get(processId);
			if (row === undefined || process === undefined) return processGone(id);
			const program = catalog.get(row.programId);
			if (program === undefined) {
				// Not "declares no renderer": a miss is also what an empty catalog looks like, and both
				// `rows` and `programs` replay their initial value, so a page can render once before the
				// registry frame lands. The honest sentence names this page's own catalog, not the kernel's.
				return noRenderer(id, `no catalog entry on this page for program ${row.programId}`);
			}
			const resolved = resolveRenderer(program.renderer);
			if (resolved._tag !== "Resolved") {
				return noRenderer(id, `this page answers to no renderer named ${program.renderer.ref}`);
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
			);
		},
		[rows, attached, catalog, resolveRenderer, views, dispatch],
	);

	const entries = useMemo(() => entriesFrom(rows, catalog), [rows, catalog]);

	// The grammar gates the desk beside the snapshot: a surface routing keys over a table nobody sent
	// it is the thing ADR 0353 took away, so it waits for one exactly as it waits for a desk.
	if (desk === null || attachment.table === null) {
		return (
			<div className="tuval-surface" data-scheme="dark">
				<p className="tuval-placeholder" role="status">
					{attachment.status === "reattaching"
						? "The connection dropped. Attaching again…"
						: "Attaching to the Tuval kernel…"}
				</p>
			</div>
		);
	}

	return (
		<Desk
			state={desk}
			dispatch={dispatch}
			resolveMount={resolveMount}
			entries={entries}
			table={attachment.table}
			reducedMotion={reducedMotion}
		/>
	);
}
