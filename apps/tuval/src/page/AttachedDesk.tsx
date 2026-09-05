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
import type {ShellMsg, ShellState} from "../shell/core/index.ts";
import {windows} from "../shell/layout/index.ts";
import type {PickerEntries} from "../shell/picker/browser.ts";
import type {AttachedProcess, PageAttachment} from "../shell/transport/browser.ts";
import type {
	AttachEvent,
	DeskSource,
	MountResolver,
	ReactWindowRenderer,
} from "../shell/ui/index.ts";
import {boundMount, Desk, noRenderer, useDeskAttachment} from "../shell/ui/index.ts";
import {empty, processGone, type ViewState} from "../shell/window/index.ts";
import type {TableRow} from "../table/row.ts";

export interface AttachedDeskProps {
	readonly page: PageAttachment;
	readonly shell: AttachedProcess<unknown, ShellMsg>;
	/** One React renderer per program id — `./renderers.tsx` says why the key is the program. */
	readonly renderers: ReadonlyMap<string, ReactWindowRenderer>;
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
 * What the picker can offer this page. The programs section is empty and says so, because the
 * process-table wire carries rows and no registry listing — a page cannot enumerate what it could
 * spawn, only what is already running. Opening by name still works through
 * `prefix : window:open <program>`, which needs no list.
 */
const entriesFrom = (rows: ReadonlyMap<ProcessId, TableRow>): PickerEntries => ({
	programs: [],
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
	const [attached, setAttached] = useState<ReadonlyMap<string, AttachedProcess>>(new Map());
	/** Ids an attach has already been started for; a second window must not open a second socket read. */
	const asked = useRef(new Set<string>());

	const source = useCallback<DeskSource>(
		(emit) => {
			emit({_tag: "Attached"} satisfies AttachEvent);
			const fiber = Effect.runFork(
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
			return () => void Effect.runFork(Fiber.interrupt(fiber));
		},
		[shell],
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
	const resolveMount = useCallback<MountResolver>(
		(windowId, processId) => {
			if (processId === null) return empty;
			const id = processId as ProcessId;
			const row = rows.get(id);
			const process = attached.get(processId);
			if (row === undefined || process === undefined) return processGone(id);
			const render = renderers.get(row.programId);
			if (render === undefined) return noRenderer(id, "this page has no renderer for its program");
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
				render,
			);
		},
		[rows, attached, renderers, views, dispatch],
	);

	const entries = useMemo(() => entriesFrom(rows), [rows]);

	if (desk === null) {
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
			reducedMotion={reducedMotion}
		/>
	);
}
