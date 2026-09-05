/**
 * @vitest-environment jsdom
 *
 * The page's wiring, over a scripted `PageAttachment`. The tier is `unit`: every claim here could be
 * wrong with a perfectly healthy socket, which is the litmus (`.patterns/effect-testing.md`), and
 * the socket itself is proven end to end in `../shell/proof/`.
 */

import {act, render, screen} from "@testing-library/react";
import {Effect, Option, Stream, SubscriptionRef} from "effect";
import {describe, expect, it} from "vitest";
import {counterId} from "../demo/counter.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {readCommandLine} from "../shell/commands/index.ts";
import {applyMsg, type ShellCmd, type ShellMsg, type ShellState} from "../shell/core/index.ts";
import {defaultPrefixTable} from "../shell/keys/index.ts";
import {createStack, createTree, createWindow} from "../shell/layout/index.ts";
import type {AttachedProcess, PageAttachment, WireProgram} from "../shell/transport/index.ts";
import {installDomShims} from "../shell/ui/dom.testing.ts";
import type {ProcessView} from "../shell/window/index.ts";
import type {TableRow} from "../table/row.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {demoRenderers} from "./renderers.tsx";

installDomShims();

const counterProcess = ProcessId.make("counter");

/** The catalog as the kernel sends it: three windowed programs, one of them the counter demo. */
const catalog: ReadonlyArray<WireProgram> = [
	{
		programId: counterId,
		label: "Counter",
		renderer: {kind: "host-native", ref: "tuval/demo/counter"},
	},
	{
		programId: ProgramId.make("tuval/log"),
		label: "Log",
		renderer: {kind: "host-native", ref: "tuval/demo/log"},
	},
	{
		programId: ProgramId.make("tuval/scratch"),
		label: "Scratch",
		renderer: {kind: "host-native", ref: "tuval/demo/counter"},
	},
];

/** One window bound to nothing: what mounts the picker, and so what the catalog is read for. */
const emptyDesk = (): ShellState => ({
	workspaces: {
		"workspace-0": {
			id: "workspace-0",
			layout: createTree(createStack("stack-root", "horizontal", [createWindow("window-1")])),
			focused: "window-1",
		},
	},
	order: ["workspace-0"],
	activeWorkspace: "workspace-0",
	views: {},
	prefix: {armed: false},
	nextId: 2,
});

/** Two windows over one process — the Vim buffer case, and the reason `attaches` is counted. */
const twoWindowDesk = (): ShellState => ({
	workspaces: {
		"workspace-0": {
			id: "workspace-0",
			layout: createTree(
				createStack("stack-root", "horizontal", [
					createWindow("window-1", counterProcess),
					createWindow("window-2", counterProcess),
				]),
			),
			focused: "window-1",
		},
	},
	order: ["workspace-0"],
	activeWorkspace: "workspace-0",
	views: {},
	prefix: {armed: false},
	nextId: 3,
});

const counterRow: TableRow = {
	id: counterProcess,
	programId: counterId,
	parentId: Option.none(),
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
};

const live = <S,>(state: S): ProcessView<S> => ({
	_tag: "Live",
	processId: counterProcess,
	lifecycle: "running",
	revision: 1,
	state,
});

interface Scripted {
	readonly page: PageAttachment;
	readonly shell: AttachedProcess<unknown, ShellMsg>;
	readonly attaches: ReadonlyArray<ProcessId>;
	readonly sent: ReadonlyArray<ShellMsg>;
}

const scripted = Effect.fn("test.scripted")(function* (options?: {
	readonly state?: ShellState;
	readonly rows?: ReadonlyArray<TableRow>;
}) {
	const desk = yield* SubscriptionRef.make<ProcessView<unknown>>(
		live(options?.state ?? twoWindowDesk()),
	);
	const counter = yield* SubscriptionRef.make<ProcessView<unknown>>(live({count: 7}));
	const attaches: Array<ProcessId> = [];
	const sent: Array<ShellMsg> = [];

	const process = (stream: Stream.Stream<ProcessView<unknown>>): AttachedProcess => ({
		processId: counterProcess,
		readProcess: stream,
		dispatch: () => Effect.succeed({_tag: "Delivered" as const}),
	});

	const page: PageAttachment = {
		rows: Stream.succeed(options?.rows ?? [counterRow]),
		programs: Stream.succeed(catalog),
		attachProcess: ((processId: ProcessId) =>
			Effect.sync(() => {
				attaches.push(processId);
				return process(SubscriptionRef.changes(counter));
			})) as PageAttachment["attachProcess"],
		detach: () => Effect.void,
		readShell: (() => SubscriptionRef.changes(desk)) as PageAttachment["readShell"],
	};
	const shell: AttachedProcess<unknown, ShellMsg> = {
		processId: ProcessId.make("shell"),
		readProcess: SubscriptionRef.changes(desk),
		dispatch: (msg) =>
			Effect.sync(() => {
				sent.push(msg);
				return {_tag: "Delivered" as const};
			}),
	};
	return {page, shell, attaches, sent} satisfies Scripted;
});

/** Let the forked stream fibers deliver before asserting; each is one microtask hop, not a clock. */
const settle = async (): Promise<void> => {
	for (let hop = 0; hop < 8; hop++) await act(async () => await Promise.resolve());
};

describe("the attached desk", () => {
	it("opens one subscription for a process shown in two windows, and mounts its renderer in both", async () => {
		const app = await Effect.runPromise(scripted());
		render(
			<AttachedDesk
				page={app.page}
				shell={app.shell}
				renderers={demoRenderers}
				reducedMotion={true}
			/>,
		);
		await settle();

		expect(app.attaches).toEqual([counterProcess]);
		const windows = screen.getAllByRole("region", {name: /^Window /});
		expect(windows.map((node) => node.getAttribute("data-window-id"))).toEqual([
			"window-1",
			"window-2",
		]);
		// One process, one state, two windows showing it.
		expect(screen.getAllByLabelText("Counter value").map((node) => node.textContent)).toEqual([
			"7",
			"7",
		]);
	});

	it("offers every program the kernel sent, by id and label, instead of the empty-section message", async () => {
		const app = await Effect.runPromise(scripted({state: emptyDesk(), rows: []}));
		render(
			<AttachedDesk
				page={app.page}
				shell={app.shell}
				renderers={demoRenderers}
				reducedMotion={true}
			/>,
		);
		await settle();

		const programs = screen.getByRole("group", {name: "Programs"});
		expect(
			[...programs.querySelectorAll('[role="option"]')].map((node) =>
				node.getAttribute("aria-label"),
			),
		).toEqual([
			`Counter — program ${counterId}`,
			"Log — program tuval/log",
			"Scratch — program tuval/scratch",
		]);
		expect(screen.queryByText("No registered program can fill a window.")).toBeNull();
	});

	it("resolves a window's renderer by the reference its program names, never by the program id", async () => {
		// `tuval/scratch` is a program this page has no entry for; its row names the counter demo's
		// renderer, and that reference is the whole of what the page resolves against.
		const scratchRow: TableRow = {...counterRow, programId: ProgramId.make("tuval/scratch")};
		const app = await Effect.runPromise(scripted({rows: [scratchRow]}));
		render(
			<AttachedDesk
				page={app.page}
				shell={app.shell}
				renderers={demoRenderers}
				reducedMotion={true}
			/>,
		);
		await settle();

		expect(screen.getAllByLabelText("Counter value").map((node) => node.textContent)).toEqual([
			"7",
			"7",
		]);
	});

	it("choosing a program from the picker asks for the same open the command line asks for", async () => {
		const app = await Effect.runPromise(scripted({state: emptyDesk(), rows: []}));
		render(
			<AttachedDesk
				page={app.page}
				shell={app.shell}
				renderers={demoRenderers}
				reducedMotion={true}
			/>,
		);
		await settle();

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
		});
		const chosen = app.sent.find((msg) => msg.type === "window.open");
		expect(chosen).toEqual({type: "window.open", windowId: "window-1", programId: counterId});

		// The typed line reaches the same Msg, and the core turns both into one `openProgram` Cmd —
		// the kernel handler that spawns and binds (`../shell/host/effects.ts`).
		const typed = readCommandLine(`window:open ${counterId}`);
		expect(typed._tag).toBe("Msg");
		const cmds = (msg: ShellMsg): readonly ShellCmd[] =>
			applyMsg(defaultPrefixTable, emptyDesk(), msg)[1];
		expect(cmds(chosen as ShellMsg)).toEqual([
			{type: "openProgram", windowId: "window-1", programId: counterId},
		]);
		expect(typed._tag === "Msg" ? cmds(typed.msg) : []).toEqual(cmds(chosen as ShellMsg));
	});

	it("sends a window's own view write back as a Msg, so the two windows' slots stay the kernel's", async () => {
		const app = await Effect.runPromise(scripted());
		render(
			<AttachedDesk
				page={app.page}
				shell={app.shell}
				renderers={demoRenderers}
				reducedMotion={true}
			/>,
		);
		await settle();

		expect(app.sent).toEqual([]);
		// The desk's own listener is the page's only input path, and it goes to the kernel.
		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", {key: "j", bubbles: true}));
		});
		expect(app.sent).toEqual([{type: "keys.press", key: expect.objectContaining({key: "j"})}]);
	});
});
