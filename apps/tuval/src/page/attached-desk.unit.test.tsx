/**
 * @vitest-environment jsdom
 *
 * The page's wiring, over a scripted `PageAttachment`. The tier is `unit`: every claim here could be
 * wrong with a perfectly healthy socket, which is the litmus (`.patterns/effect-testing.md`), and
 * the socket itself is proven end to end in `../shell/proof/`.
 */

import {assert, describe, it} from "@effect/vitest";
import {act, render, screen} from "@testing-library/react";
import {Effect, Option, Schema, Stream, SubscriptionRef} from "effect";
import {Socket} from "effect/unstable/socket";
import {counterId} from "../demo/counter.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {readCommandLine} from "../shell/commands/index.ts";
import {applyMsg, type ShellCmd, type ShellMsg, type ShellState} from "../shell/core/index.ts";
import {defaultPrefixTable, type PrefixTable} from "../shell/keys/index.ts";
import {createStack, createTree, createWindow} from "../shell/layout/index.ts";
import type {AttachedProcess, PageAttachment, WireProgram} from "../shell/transport/browser.ts";
import {installDomShims} from "../shell/ui/dom.testing.ts";
import type {ProcessView} from "../shell/window/index.ts";
import type {TableRow} from "../table/row.ts";
import {AttachedDesk} from "./AttachedDesk.tsx";
import {pageRenderers} from "./renderers.tsx";

/** The table over a socket that answers no call: this file judges mounting, never a spell. */
const renderers = pageRenderers(
	() => Effect.never,
	() => undefined,
);

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
	desk: {inspectorOpen: false},
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
	desk: {inspectorOpen: false},
	prefix: {armed: false},
	nextId: 3,
});

const counterRow: TableRow = {
	id: counterProcess,
	programId: counterId,
	parentId: Option.none(),
	ports: {},
	stateSummary: {lifecycle: "running", revision: 1},
	title: Option.none(),
	status: Option.none(),
};

const live = <S,>(state: S, revision = 1): ProcessView<S> => ({
	_tag: "Live",
	processId: counterProcess,
	lifecycle: "running",
	revision,
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
	readonly programs?: ReadonlyArray<WireProgram>;
	/** `null` scripts a kernel that has not sent its grammar yet — the desk must not render. */
	readonly keys?: PrefixTable | null;
	/** When this socket ends. The default never does, which is what every claim but the drop wants. */
	readonly closed?: Effect.Effect<Socket.SocketError>;
	/**
	 * The revision the shell's first snapshot carries. `0` is a kernel whose shell has not committed
	 * anything yet, which is every freshly spawned one (`../process/Processes.ts`).
	 */
	readonly revision?: number;
}) {
	const desk = yield* SubscriptionRef.make<ProcessView<unknown>>(
		live(options?.state ?? twoWindowDesk(), options?.revision),
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
		spells: Stream.empty,
		rows: Stream.succeed(options?.rows ?? [counterRow]),
		programs: Stream.succeed(options?.programs ?? catalog),
		call: () => Effect.never,
		keys:
			options?.keys === null ? Stream.never : Stream.succeed(options?.keys ?? defaultPrefixTable),
		attachProcess: ((processId: ProcessId) =>
			Effect.sync(() => {
				attaches.push(processId);
				return process(SubscriptionRef.changes(counter));
			})) as PageAttachment["attachProcess"],
		detach: () => Effect.void,
		closed: options?.closed ?? Effect.never,
		readShell: (() => SubscriptionRef.changes(desk)) as PageAttachment["readShell"],
	};
	// The kernel behind the socket, as far as a key press is concerned: it folds the Msg and its
	// acknowledgement carries the state that followed, which is where the page reads the answer to
	// its own key (#8274, `../shell/transport/wire.ts`).
	let held = options?.state ?? twoWindowDesk();
	let revision = 0;
	const shell: AttachedProcess<unknown, ShellMsg> = {
		processId: ProcessId.make("shell"),
		readProcess: SubscriptionRef.changes(desk),
		dispatch: (msg) =>
			Effect.sync(() => {
				sent.push(msg);
				held = applyMsg(defaultPrefixTable, held, msg)[0];
				revision += 1;
				return {_tag: "Delivered" as const, view: {revision, state: held}};
			}),
	};
	return {page, shell, attaches, sent} satisfies Scripted;
});

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

/**
 * Let the forked stream fibers deliver before asserting; each is one microtask hop, not a clock.
 * `act` answers a `Promise`, so the lift is object-notation `tryPromise` + `orDie` — the sanctioned
 * stand-in for the banned `Effect.promise` (#2736).
 */
const settle = Effect.gen(function* () {
	for (let hop = 0; hop < 8; hop++) {
		yield* Effect.tryPromise({
			try: () => act(async () => await Promise.resolve()),
			catch: (cause) => new TestIo({cause}),
		}).pipe(Effect.orDie);
	}
});

describe("the attached desk", () => {
	it.effect(
		"opens one subscription for a process shown in two windows, and mounts its renderer in both",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted();
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.deepStrictEqual(app.attaches, [counterProcess]);
				const windows = screen.getAllByRole("region", {name: /^Window /});
				assert.deepStrictEqual(
					windows.map((node) => node.getAttribute("data-window-id")),
					["window-1", "window-2"],
				);
				// One process, one state, two windows showing it.
				assert.deepStrictEqual(
					screen.getAllByLabelText("Counter value").map((node) => node.textContent),
					["7", "7"],
				);
			}),
	);

	it.effect(
		"renders a kernel whose shell has committed nothing yet, whose first snapshot is revision 0",
		() =>
			Effect.gen(function* () {
				// The high-water mark is "nothing seen yet", not `0`: a freshly spawned shell sits at
				// revision 0 until a row exists to commit against, so a zero sentinel drops the only
				// snapshot the page is ever sent and leaves the desk on its placeholder (#8274).
				const app = yield* scripted({revision: 0});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.isNull(screen.queryByText("Attaching to the Tuval kernel…"));
				assert.deepStrictEqual(
					screen
						.getAllByRole("region", {name: /^Window /})
						.map((node) => node.getAttribute("data-window-id")),
					["window-1", "window-2"],
				);
			}),
	);

	it.effect(
		"offers every program the kernel sent, by id and label, instead of the empty-section message",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted({state: emptyDesk(), rows: []});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				const programs = screen.getByRole("group", {name: "Programs"});
				assert.deepStrictEqual(
					[...programs.querySelectorAll('[role="option"]')].map((node) =>
						node.getAttribute("aria-label"),
					),
					[
						`Counter — program ${counterId}`,
						"Log — program tuval/log",
						"Scratch — program tuval/scratch",
					],
				);
				assert.isNull(screen.queryByText("No registered program can fill a window."));
			}),
	);

	it.effect(
		"resolves a window's renderer by the reference its program names, never by the program id",
		() =>
			Effect.gen(function* () {
				// `tuval/scratch` is a program this page has no entry for; its row names the counter
				// demo's renderer, and that reference is the whole of what the page resolves against.
				const scratchRow: TableRow = {...counterRow, programId: ProgramId.make("tuval/scratch")};
				const app = yield* scripted({rows: [scratchRow]});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.deepStrictEqual(
					screen.getAllByLabelText("Counter value").map((node) => node.textContent),
					["7", "7"],
				);
			}),
	);

	it.effect(
		"holds the window with a placeholder when the process's program is not in the catalog",
		() =>
			Effect.gen(function* () {
				// The empty catalog is also the transient: `programs` replays its initial value, so a table
				// row can reach the page a frame before the registry frame does.
				const app = yield* scripted({programs: []});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.lengthOf(
					screen.getAllByText(
						`Process ${counterProcess} is running, but no catalog entry on this page for program ${counterId}.`,
					),
					2,
				);
				assert.isNull(screen.queryByLabelText("Counter value"));
			}),
	);

	it.effect(
		"holds the window with a placeholder when the page answers to no renderer of that name",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted({
					programs: [
						{
							programId: counterId,
							label: "Counter",
							renderer: {kind: "host-native", ref: "tuval/demo/absent"},
						},
					],
				});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.lengthOf(
					screen.getAllByText(
						`Process ${counterProcess} is running, but this page answers to no renderer named tuval/demo/absent.`,
					),
					2,
				);
				assert.isNull(screen.queryByLabelText("Counter value"));
			}),
	);

	it.effect(
		"choosing a program from the picker asks for the same open the command line asks for",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted({state: emptyDesk(), rows: []});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				act(() => {
					document.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
				});
				// The key reaches the picker on the kernel's answer, so the press is one hop from the
				// choice it makes (#8274).
				yield* settle;
				const chosen = app.sent.find((msg) => msg.type === "window.open");
				assert.deepStrictEqual(chosen, {
					type: "window.open",
					windowId: "window-1",
					programId: counterId,
				});

				// The typed line reaches the same Msg, and the core turns both into one `openProgram` Cmd —
				// the kernel handler that spawns and binds (`../shell/host/effects.ts`).
				const typed = readCommandLine(`window:open ${counterId}`);
				assert.strictEqual(typed._tag, "Msg");
				const cmds = (msg: ShellMsg): readonly ShellCmd[] =>
					applyMsg(defaultPrefixTable, emptyDesk(), msg)[1];
				assert.deepStrictEqual(cmds(chosen as ShellMsg), [
					{type: "openProgram", windowId: "window-1", programId: counterId},
				]);
				assert.deepStrictEqual(
					typed._tag === "Msg" ? cmds(typed.msg) : [],
					cmds(chosen as ShellMsg),
				);
			}),
	);

	it.effect(
		"sends a window's own view write back as a Msg, so the two windows' slots stay the kernel's",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted();
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				assert.deepStrictEqual(app.sent, []);
				// The desk's own listener is the page's only input path, and it goes to the kernel.
				act(() => {
					document.dispatchEvent(new KeyboardEvent("keydown", {key: "j", bubbles: true}));
				});
				assert.lengthOf(app.sent, 1);
				const press = app.sent.at(0);
				assert.strictEqual(press?.type, "keys.press");
				assert.include(press?.type === "keys.press" ? press.key : {}, {key: "j"});
			}),
	);

	it.effect(
		"shows no desk until the kernel has sent its key grammar, and no key reaches the kernel",
		() =>
			Effect.gen(function* () {
				const app = yield* scripted({keys: null});
				render(
					<AttachedDesk
						page={app.page}
						shell={app.shell}
						renderers={renderers}
						reducedMotion={true}
						refusal={null}
					/>,
				);
				yield* settle;

				// The snapshot arrived; only the grammar did not, and that alone holds the desk back.
				assert.deepStrictEqual(screen.queryAllByRole("region", {name: /^Window /}), []);
				assert.strictEqual(
					screen.getByRole("status").textContent,
					"Attaching to the Tuval kernel…",
				);
				act(() => {
					document.dispatchEvent(new KeyboardEvent("keydown", {key: "j", bubbles: true}));
				});
				assert.deepStrictEqual(app.sent, []);
			}),
	);
});

describe("the desk across a dropped socket", () => {
	const dropped = new Socket.SocketError({reason: new Socket.SocketCloseError({code: 1006})});

	it.effect("keeps the last desk on screen and says it is no longer current", () =>
		Effect.gen(function* () {
			const app = yield* scripted({closed: Effect.succeed(dropped)});
			render(
				<AttachedDesk
					page={app.page}
					shell={app.shell}
					renderers={renderers}
					reducedMotion={true}
					refusal={null}
				/>,
			);
			yield* settle;

			// The whole point of the banner: the windows are still there to read, and the reader is
			// told what they are worth.
			assert.lengthOf(screen.getAllByRole("region", {name: /^Window /}), 2);
			const banner = screen.getByRole("status", {name: "Connection"});
			assert.include(banner.textContent ?? "", "Reconnecting…");
			assert.include(banner.textContent ?? "", "1006");
		}),
	);

	it.effect("turns the banner into an alert once the page has stopped trying", () =>
		Effect.gen(function* () {
			const app = yield* scripted({closed: Effect.succeed(dropped)});
			render(
				<AttachedDesk
					page={app.page}
					shell={app.shell}
					renderers={renderers}
					reducedMotion={true}
					refusal="the kernel refused or did not answer 30 attempt(s)."
				/>,
			);
			yield* settle;

			assert.lengthOf(screen.getAllByRole("region", {name: /^Window /}), 2);
			assert.isNull(screen.queryByRole("status", {name: "Connection"}));
			assert.include(
				screen.getByRole("alert", {name: "Connection"}).textContent ?? "",
				"30 attempt(s)",
			);
		}),
	);

	it.effect("re-opens one subscription per shown process on a replacement link, not a second", () =>
		Effect.gen(function* () {
			const first = yield* scripted({closed: Effect.succeed(dropped)});
			const view = render(
				<AttachedDesk
					page={first.page}
					shell={first.shell}
					renderers={renderers}
					reducedMotion={true}
					refusal={null}
				/>,
			);
			yield* settle;
			assert.deepStrictEqual(first.attaches, [counterProcess]);

			const second = yield* scripted();
			view.rerender(
				<AttachedDesk
					page={second.page}
					shell={second.shell}
					renderers={renderers}
					reducedMotion={true}
					refusal={null}
				/>,
			);
			yield* settle;

			// The ids the old socket was asked for are dropped with it, so the new one is asked once
			// for the same process rather than never (a stale `asked` set) or twice.
			assert.deepStrictEqual(second.attaches, [counterProcess]);
			assert.deepStrictEqual(first.attaches, [counterProcess]);
			assert.lengthOf(screen.getAllByRole("region", {name: /^Window /}), 2);
			assert.isNull(screen.queryByRole("status", {name: "Connection"}));
		}),
	);
});
