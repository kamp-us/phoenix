/**
 * @vitest-environment jsdom
 *
 * The desk-level half of both programs, judged through the mechanism rather than beside it: every
 * assertion below starts at a `DeskSnapshot` whose `programs` table holds the **real** registry rows
 * and walks `inspectorFor` / `statusFor` (`../shell/desk/compose.ts`, #7691) to whatever those rows
 * declare. Nothing here calls a renderer the shell did not hand back, so a reference that stopped
 * resolving would fail these tests rather than pass them against a directly-imported function.
 *
 * The three claims this file exists for: the two programs' inspectors show the same facts for one
 * selection, the status renderers put their own segments in the middle and nothing else, and
 * neither renderer writes anything — the host they are given records every call, and the count is
 * the assertion.
 */

import {cleanup, render, screen, waitFor} from "@testing-library/react";
import {Effect, Stream} from "effect";
import type {ReactNode} from "react";
import {afterEach, describe, expect, it} from "vitest";
import {ProcessId} from "../protocol/ids.ts";
import type {ProcessRow} from "../protocol/process-row.ts";
import type {AnyProgram} from "../registry/program.ts";
import type {AnyInspectorRenderer, AnyStatusRenderer, DeskSnapshot} from "../shell/desk/index.ts";
import {inspectorFor, statusFor} from "../shell/desk/index.ts";
import type {AnyWindowHost, ProcessView} from "../shell/window/index.ts";
import {delivered, WindowId} from "../shell/window/index.ts";
import {
	ENGINE_VIEW_INSPECTOR_REF,
	ENGINE_VIEW_STATUS_REF,
	engineViewProgram,
} from "./engine-view/program.ts";
import {engineViewStatusRenderer} from "./engine-view/status.ts";
import {engineViewInspectorRenderer} from "./engine-view/ui/inspector.tsx";
import {row} from "./ps/fixtures.ts";
import {psInspectorRenderer} from "./ps/inspector.tsx";
import {PS_INSPECTOR_REF, PS_STATUS_REF, psProgram} from "./ps/program.ts";
import {type PsState, psInitialState} from "./ps/state.ts";
import {psStatusRenderer} from "./ps/status.ts";

afterEach(cleanup);

const windowId = WindowId.make("window-1");
const viewerProcessId = ProcessId.make("viewer-1");

/** The rows both programs read. One selectable process with two ports, and a root above it. */
const processes: ReadonlyArray<ProcessRow> = [
	row("root-a", {program: "counter", revision: 1}),
	row("child-a1", {
		parent: "root-a",
		program: "shell",
		revision: 12,
		lifecycle: "stopping",
		ports: {
			prompt: {kind: "tuval/prompt", direction: "in"},
			transcript: {kind: "tuval/transcript", direction: "out"},
		},
	}),
];

const selected = ProcessId.make("child-a1");

/** A host that answers with one state and records every write a renderer might attempt. */
interface RecordingHost {
	readonly host: AnyWindowHost;
	readonly writes: Array<string>;
}

const recordingHost = (state: unknown): RecordingHost => {
	const writes: Array<string> = [];
	const view: ProcessView<unknown> = {
		_tag: "Live",
		processId: viewerProcessId,
		lifecycle: "running",
		revision: 0,
		state,
	};
	const host: AnyWindowHost = {
		windowId,
		processId: viewerProcessId,
		readProcess: Stream.succeed(view),
		dispatch: (msg: {readonly type: string}) =>
			Effect.sync(() => {
				writes.push(`dispatch:${msg.type}`);
				return delivered;
			}),
		view: () => null,
		setView: () => Effect.sync(() => void writes.push("setView")),
	};
	return {host, writes};
};

/**
 * A desk snapshot focused on one window of `program`. `programs` holds the registry row itself, so
 * the two references the walk follows are the ones the row declares and not a restatement of them.
 */
const snapshotFor = (
	program: AnyProgram,
	host: AnyWindowHost,
	inspectors: Readonly<Record<string, AnyInspectorRenderer>>,
	statuses: Readonly<Record<string, AnyStatusRenderer>>,
): DeskSnapshot => ({
	workspace: "workspace-0",
	kernel: {processes: processes.length, revision: 7},
	focused: {windowId, processId: viewerProcessId, host},
	processes: {[viewerProcessId]: {programId: program.id}},
	programs: {[program.id]: program},
	inspectors,
	statuses,
});

const engineViewSnapshot = (host: AnyWindowHost, state: {readonly selected: ProcessId | null}) =>
	snapshotFor(
		engineViewProgram(),
		host,
		{[ENGINE_VIEW_INSPECTOR_REF]: engineViewInspectorRenderer(processes)},
		{[ENGINE_VIEW_STATUS_REF]: engineViewStatusRenderer({processes, state})},
	);

const psSnapshot = (host: AnyWindowHost, state: PsState) =>
	snapshotFor(
		psProgram,
		host,
		{[PS_INSPECTOR_REF]: psInspectorRenderer(processes)},
		{[PS_STATUS_REF]: psStatusRenderer({processes, state})},
	);

/** Mount whatever the inspector region resolved to, and wait for the selection stream to land. */
const mountInspector = async (snapshot: DeskSnapshot, expected: string): Promise<string> => {
	const region = inspectorFor(snapshot);
	if (region._tag !== "Inspector") throw new Error(`no inspector: ${region.reason}`);
	const node: ReactNode = region.renderer.render(region.host);
	render(<>{node}</>);
	await waitFor(() => expect(screen.getByRole("heading", {name: expected})).toBeTruthy());
	return screen.getByRole("heading", {name: expected}).parentElement?.textContent ?? "";
};

describe("engine-view and ps desk renderers", () => {
	it("resolves both renderers off the registry rows the programs declare", () => {
		const engine = engineViewProgram();
		expect(engine.inspector).toEqual({kind: "host-native", ref: ENGINE_VIEW_INSPECTOR_REF});
		expect(engine.status).toEqual({kind: "host-native", ref: ENGINE_VIEW_STATUS_REF});
		expect(psProgram.inspector).toEqual({kind: "host-native", ref: PS_INSPECTOR_REF});
		expect(psProgram.status).toEqual({kind: "host-native", ref: PS_STATUS_REF});

		const engineHost = recordingHost({selected}).host;
		expect(inspectorFor(engineViewSnapshot(engineHost, {selected}))._tag).toBe("Inspector");
		expect(statusFor(engineViewSnapshot(engineHost, {selected})).middleEmpty).toBeNull();

		const psHost = recordingHost(psInitialState).host;
		expect(inspectorFor(psSnapshot(psHost, psInitialState))._tag).toBe("Inspector");
		expect(statusFor(psSnapshot(psHost, psInitialState)).middleEmpty).toBeNull();
	});

	it("shows the same facts in both programs' inspectors for one selection", async () => {
		const engine = await mountInspector(
			engineViewSnapshot(recordingHost({selected}).host, {selected}),
			"child-a1",
		);
		cleanup();
		const table = await mountInspector(
			psSnapshot(recordingHost({...psInitialState, selectedProcessId: selected}).host, {
				...psInitialState,
				selectedProcessId: selected,
			}),
			"child-a1",
		);
		expect(engine).toEqual(table);
		for (const fragment of ["shell", "root-a", "stopping", "12", "prompt", "transcript"]) {
			expect(engine).toContain(fragment);
		}
	});

	it("renders the named empty state when a program has nothing selected", () => {
		const region = inspectorFor(
			engineViewSnapshot(recordingHost({selected: null}).host, {
				selected: null,
			}),
		);
		if (region._tag !== "Inspector") throw new Error(`no inspector: ${region.reason}`);
		render(<>{region.renderer.render(region.host)}</>);
		expect(screen.getByRole("status").textContent).toContain("No process selected");
	});

	it("renders the gone state when the selection has left the table, and does not throw", async () => {
		const gone = ProcessId.make("child-a1");
		const shrunk = processes.filter((process) => process.id !== gone);
		const region = inspectorFor(
			snapshotFor(
				psProgram,
				recordingHost({...psInitialState, selectedProcessId: gone}).host,
				{
					[PS_INSPECTOR_REF]: psInspectorRenderer(shrunk),
				},
				{},
			),
		);
		if (region._tag !== "Inspector") throw new Error(`no inspector: ${region.reason}`);
		expect(() => render(<>{region.renderer.render(region.host)}</>)).not.toThrow();
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toContain("has left the table"),
		);
	});

	it("puts each program's segments in the middle and leaves the shell's own ends alone", () => {
		const bar = statusFor(engineViewSnapshot(recordingHost({selected}).host, {selected}));
		expect(bar.middle).toEqual([
			{id: "processes", text: "2 processes"},
			{id: "edges", text: "1 edge"},
			{id: "selected", text: "selected child-a1"},
		]);
		expect(bar.left).toEqual([{id: "workspace", text: "workspace-0"}]);
		expect(bar.right).toEqual([
			{id: "processes", text: "2 processes"},
			{id: "revision", text: "rev 7"},
		]);

		const psBar = statusFor(psSnapshot(recordingHost(psInitialState).host, psInitialState));
		expect(psBar.middle).toEqual([
			{id: "processes", text: "2 processes"},
			{id: "order", text: "default order"},
		]);
	});

	it("writes nothing through the host: no dispatch, no view write, and one answer per input", async () => {
		const engine = recordingHost({selected});
		await mountInspector(engineViewSnapshot(engine.host, {selected}), "child-a1");
		const table = recordingHost({...psInitialState, selectedProcessId: selected});
		const bar = statusFor(psSnapshot(table.host, {...psInitialState, selectedProcessId: selected}));
		expect(bar.middle).toEqual(
			statusFor(psSnapshot(table.host, {...psInitialState, selectedProcessId: selected})).middle,
		);
		expect([engine.writes, table.writes]).toEqual([[], []]);
	});
});
