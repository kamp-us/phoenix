/**
 * The Pi vertical (#7573): one Pi chat opened in the real shell from the real picker, chatted with,
 * the app stopped and booted again, the page re-attached, the transcript intact.
 *
 * It is the shell's own end-to-end proof (`../../shell/proof/end-to-end.integration.test.ts`) with
 * a Pi session where the demo programs were — same kernel, same `serveDesk` socket, same page
 * `attach`, same keys-and-Msgs input vocabulary. The one substitution is the layer: Pi's own
 * `fauxProvider` runs the real agent loop against scripted replies, so CI calls no model API
 * (founder ruling 2026-09-02, amended on #7573; the real provider is exercised by hand).
 *
 * **Every assertion reads process state off the transport**, never off a `ProcessHandle` and never
 * off a DOM. What a window is handed is `readProcess` and `dispatch` (`../../shell/window/host.ts`);
 * this file holds exactly those two, so what it proves is what `PiChatWindow` would see.
 *
 * **One dispatch here stands in for a caller that does not exist yet.** Nothing on the shipped path
 * opens a fresh agent session — the core comes up `idle` and no shipped caller sends `start`
 * ([#7925](https://github.com/kamp-us/phoenix/issues/7925)). So the proof sends it, on the process,
 * over the transport, exactly where that caller will sit. Everything downstream is unaltered.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, type FileSystem, Queue, Result, Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {ProcessId} from "../../process/process.ts";
import {
	activeWorkspace,
	type ShellMsg,
	type ShellState,
	windowIds,
} from "../../shell/core/index.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable, type Key, parse} from "../../shell/keys/index.ts";
import {windows} from "../../shell/layout/index.ts";
import {
	mountPicker,
	type PickerEntries,
	type PickerView,
	pickerKey,
	readEntries,
} from "../../shell/picker/index.ts";
import {shellNode} from "../../shell/program.ts";
import {attach, type PageAttachment} from "../../shell/transport/client.ts";
import type {ProcessView} from "../../shell/window/index.ts";
import type {TableRow} from "../../table/row.ts";
import {PI_SESSION_PROGRAM} from "../renderer-ref.ts";
import {
	PROJECT_ROOT_VAR,
	PROMPT_1,
	PROMPT_2,
	PROMPT_3,
	PROMPT_4,
	REPLY_1,
	REPLY_2,
} from "./names.ts";

const TIMEOUT = 180_000;

const configModule = fileURLToPath(new URL("./desk.ts", import.meta.url));

/** The shell is spawned at its graph node's id, so the desk's process id is known before boot. */
const shellProcessId = ProcessId.make(shellNode);

const tempDirs: string[] = [];

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-vertical-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	process.env[PROJECT_ROOT_VAR] = dir;
	return dir;
};

/**
 * The whole app for one project root, built into the caller's Scope — so closing that Scope is the
 * app stopping, which is what the restart proof does.
 */
const bootDesk = Effect.fn("piVertical.bootDesk")(function* (project: string) {
	const booted = yield* boot({global: configModule, project});
	const server = yield* serveDesk({kernel: booted.kernel, port: 0, table: defaultPrefixTable});
	const entries = yield* readEntries.pipe(Effect.provideContext(booted.kernel));
	return {booted, server, entries};
});

/** Every value a stream published, in order, so a read proves the subscription is live. */
const watch = Effect.fn("piVertical.watch")(function* <A>(stream: Stream.Stream<A>) {
	const seen = yield* Queue.unbounded<A>();
	yield* Effect.forkScoped(
		Stream.runForEach(stream, (value) => Effect.asVoid(Queue.offer(seen, value))),
	);
	return seen;
});

/**
 * The next published value satisfying `predicate`. A dispatch is acknowledged when the Msg reaches
 * the actor, and the frame that follows is a separate write on the same socket, so waiting for the
 * state rather than for the ack is the only read that cannot see a frame from before the input. The
 * last value that did arrive rides the failure, because that is the whole diagnosis.
 */
const where = <A>(seen: Queue.Queue<A>, what: string, predicate: (value: A) => boolean) => {
	let last: A | null = null;
	return Effect.gen(function* () {
		while (true) {
			const value = yield* Queue.take(seen);
			last = value;
			if (predicate(value)) return value;
		}
	}).pipe(
		Effect.timeout("60 seconds"),
		Effect.catchTag("TimeoutError", () =>
			Effect.die(new Error(`nothing where ${what}; last seen: ${JSON.stringify(last)}`)),
		),
	);
};

const liveWhere = <S>(
	seen: Queue.Queue<ProcessView<S>>,
	what: string,
	predicate: (state: S) => boolean,
): Effect.Effect<S> =>
	where(seen, what, (view) => view._tag === "Live" && predicate(view.state)).pipe(
		Effect.map((view) => (view as {readonly state: S}).state),
	);

/**
 * The newest state the stream has published, draining whatever is already queued.
 *
 * A desk stops emitting once the keys stop, so a `liveWhere` asked for a state that has already
 * gone past blocks until the timeout. This is the read for "what does it look like *now*": it
 * returns `current` when nothing further has arrived, and the last frame that did otherwise.
 */
const settled = <S>(seen: Queue.Queue<ProcessView<S>>, current: S): Effect.Effect<S> =>
	Effect.gen(function* () {
		let last = current;
		while (true) {
			const view = yield* Queue.take(seen).pipe(
				Effect.timeout("500 millis"),
				Effect.catchTag("TimeoutError", () => Effect.succeed(null)),
			);
			if (view === null) return last;
			if (view._tag === "Live") last = view.state;
		}
	});

const workspaceOf = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	assert.isDefined(workspace, "the desk has an active workspace");
	return workspace;
};

const windowsOf = (state: ShellState): readonly string[] => windowIds(workspaceOf(state));

const boundProcess = (state: ShellState, windowId: string): string | null => {
	for (const window of windows(workspaceOf(state).layout.root)) {
		if (window.id === windowId) return window.processId;
	}
	return null;
};

const keyOf = (spelling: string): Key => {
	const parsed = parse(spelling);
	assert.isTrue(Result.isSuccess(parsed), `\`${spelling}\` is a key`);
	return Result.getOrThrow(parsed);
};

interface Desk {
	readonly send: (msg: ShellMsg) => Effect.Effect<void>;
	readonly seen: Queue.Queue<ProcessView<ShellState>>;
}

const press = (desk: Desk, ...spellings: ReadonlyArray<string>) =>
	Effect.forEach(spellings, (spelling) => desk.send({type: "keys.press", key: keyOf(spelling)}), {
		concurrency: 1,
		discard: true,
	});

/** A page attached to the shell process, with its state stream and the process table already running. */
const attachDesk = Effect.fn("piVertical.attachDesk")(function* (url: string) {
	const page = yield* attach(url).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
	const shell = yield* page.attachProcess<ShellState, ShellMsg>(shellProcessId);
	const seen = yield* watch(shell.readProcess);
	const rows = yield* watch(page.rows);
	const desk: Desk = {send: (msg) => Effect.asVoid(shell.dispatch(msg)), seen};
	return {page, desk, rows};
});

/**
 * The picker's own answer to a key, turned into the Msg the browser surface would dispatch
 * (`../../shell/ui/PickerView.tsx` does exactly this switch). Driving the real `pickerKey` is what
 * makes "opened from the picker" a claim about the picker rather than about a hand-written Msg.
 */
const pickerPress = (
	windowId: string,
	entries: PickerEntries,
	view: PickerView,
	spelling: string,
): ShellMsg | null => {
	const answer = pickerKey(windowId as never, entries, view, spelling);
	switch (answer._tag) {
		case "Moved":
		case "Cleared":
			return {type: "window.setView", windowId: windowId as never, view: answer.view};
		case "Chose":
			return answer.intent._tag === "OpenProgram"
				? {type: "window.open", windowId: windowId as never, programId: answer.intent.programId}
				: {type: "window.attach", windowId: windowId as never, processId: answer.intent.processId};
		case "Ignored":
			return null;
	}
};

/** Walk the picker's highlight onto `pi-session` and choose it, one real `pickerKey` answer per step. */
const openPiFromThePicker = Effect.fn("piVertical.openPiFromThePicker")(function* (
	desk: Desk,
	entries: PickerEntries,
	windowId: string,
) {
	const at = entries.programs.findIndex((entry) => entry.programId === PI_SESSION_PROGRAM);
	assert.isAtLeast(at, 0, "the picker offers the pi-session program");
	let view = mountPicker();
	for (let step = 0; step < at; step += 1) {
		const moved = pickerPress(windowId, entries, view, "j");
		assert.isNotNull(moved, "the picker moved its highlight");
		view = {cursor: view.cursor + 1, refusal: null};
		yield* desk.send(moved as ShellMsg);
	}
	const chosen = pickerPress(windowId, entries, view, "<enter>");
	assert.isNotNull(chosen, "the picker chose the highlighted row");
	yield* desk.send(chosen as ShellMsg);
	const opened = yield* liveWhere(
		desk.seen,
		"the window bound to a process",
		(state) => boundProcess(state, windowId) !== null,
	);
	return {processId: boundProcess(opened, windowId) as string, desk: opened};
});

/** The transcript as a window renders it: `kind:id` per item, which is what a rendered row is keyed by. */
const rendered = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.map((item) => `${item.kind}:${item.id}`);

const textsIn = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) =>
		item.kind === "user" || item.kind === "assistant" ? [item.text] : [],
	);

const replies = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));

interface Session {
	readonly processId: ProcessId;
	readonly seen: Queue.Queue<ProcessView<AiAgentSessionState>>;
	readonly send: (msg: AiAgentSessionMsg) => Effect.Effect<void>;
}

const attachSession = Effect.fn("piVertical.attachSession")(function* (
	page: PageAttachment,
	processId: string,
) {
	const id = ProcessId.make(processId);
	const process = yield* page.attachProcess<AiAgentSessionState, AiAgentSessionMsg>(id);
	const seen = yield* watch(process.readProcess);
	return {
		processId: id,
		seen,
		send: (msg: AiAgentSessionMsg) => Effect.asVoid(process.dispatch(msg)),
	} satisfies Session;
});

/**
 * One prompt and the one reply it must produce.
 *
 * The wait is on the reply *count* rather than on the phase, because a Pi turn can end with the
 * core still at `prompting` (#7897), and on the count rather than on the reply's text, because a
 * boot's provider starts at the head of its script — the same text can legitimately appear twice in
 * one transcript across a restart, and a text match would have passed on the older copy.
 */
const chat = Effect.fn("piVertical.chat")(function* (
	session: Session,
	before: AiAgentSessionState,
	text: string,
	key: string,
) {
	const was = replies(before).length;
	yield* session.send({type: "prompt", text, key});
	const after = yield* liveWhere(
		session.seen,
		`the reply to "${text}"`,
		(state) => textsIn(state).includes(text) && replies(state).length > was,
	);
	assert.strictEqual(
		replies(after).length,
		was + 1,
		`one prompt produced ${replies(after).length - was} replies`,
	);
	return after;
});

/**
 * No Fate, no SSE, no `EventSource` — asserted by substituting both rather than by looking
 * afterwards. `fetch` records every call it is handed and the `EventSource` stand-in records every
 * construction, so `noLiveHttp` below judges one list and its failure names the URL.
 */
const withNoLiveHttp = <A, E, R>(body: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const realFetch = globalThis.fetch;
		const realEventSource = Reflect.get(globalThis, "EventSource");
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(String(input));
			return realFetch(input as never, init);
		}) as typeof fetch;
		Reflect.set(
			globalThis,
			"EventSource",
			class {
				constructor(url: string) {
					calls.push(`EventSource ${url}`);
				}
			},
		);
		const result = yield* Effect.onExit(body, () =>
			Effect.sync(() => {
				globalThis.fetch = realFetch;
				Reflect.set(globalThis, "EventSource", realEventSource);
			}),
		);
		return {result, calls};
	});

const noLiveHttp = (calls: ReadonlyArray<string>): void => {
	assert.deepStrictEqual(
		calls.filter((url) => /fate|event-stream|EventSource|\/live/.test(url)),
		[],
		"the proof reached for Fate, an SSE stream or an EventSource",
	);
	assert.deepStrictEqual(
		calls,
		[],
		"the proof made an HTTP request; a Tuval desk speaks WebSocket and nothing else",
	);
};

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("a Pi session in the Tuval shell, end to end", () => {
	it.live(
		"opens from the picker under the shell, answers two prompts, and shows one transcript in two windows with two view slots",
		() =>
			run(
				Effect.gen(function* () {
					const {result, calls} = yield* withNoLiveHttp(
						Effect.gen(function* () {
							const project = freshProject();
							const app = yield* bootDesk(project);
							const {page, desk, rows} = yield* attachDesk(app.server.launchUrl);

							const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
							const only = windowsOf(fresh)[0] as string;
							assert.isDefined(only);
							assert.isNull(boundProcess(fresh, only), "a fresh desk shows the picker");

							const {processId: agentId} = yield* openPiFromThePicker(desk, app.entries, only);

							// The picker spawns under the shell (`../../shell/picker/open.ts`), and the wire
							// row is where that parentage is readable without touching a handle.
							const table = yield* where(rows, "the agent's row in the process table", (list) =>
								list.some((row: TableRow) => row.id === agentId),
							);
							const row = table.find((entry: TableRow) => entry.id === agentId) as TableRow;
							assert.strictEqual(row.programId, PI_SESSION_PROGRAM);
							assert.strictEqual(
								row.parentId._tag === "Some" ? row.parentId.value : null,
								shellProcessId,
								"the picker opened the Pi process under some other parent",
							);
							assert.lengthOf(
								table.filter((entry: TableRow) => entry.programId === PI_SESSION_PROGRAM),
								1,
								"one choice opened more than one Pi process",
							);

							const session = yield* attachSession(page, agentId);
							yield* session.send({type: "start", cwd: project, resume: null});
							const ready = yield* liveWhere(
								session.seen,
								"the session to open",
								(s) => s.phase === "ready",
							);
							assert.strictEqual(ready.cwd, project, "the session opened outside the project root");

							const once = yield* chat(session, ready, PROMPT_1, "k1");
							const twice = yield* chat(session, once, PROMPT_2, "k2");
							assert.deepStrictEqual(
								replies(twice),
								[REPLY_1, REPLY_2],
								"two prompts did not produce this boot's two scripted replies, in order",
							);

							// The second window binds the process the first one opened rather than opening
							// another: `window:open` spawns, and one process in two windows is `window:attach`
							// (`../../shell/picker/open.ts`).
							yield* press(desk, "<c-b>", "|");
							const split = yield* liveWhere(
								desk.seen,
								"a second window",
								(state) => windowsOf(state).length === 2,
							);
							const second = windowsOf(split).find((id) => id !== only) as string;
							assert.isDefined(second);
							yield* desk.send({
								type: "window.attach",
								windowId: second as never,
								processId: ProcessId.make(agentId),
							});
							const shared = yield* liveWhere(
								desk.seen,
								"both windows on the Pi process",
								(state) =>
									boundProcess(state, only) === agentId && boundProcess(state, second) === agentId,
							);
							assert.strictEqual(boundProcess(shared, only), boundProcess(shared, second));

							yield* desk.send({
								type: "window.setView",
								windowId: only as never,
								view: {scroll: 0},
							});
							yield* desk.send({
								type: "window.setView",
								windowId: second as never,
								view: {scroll: 24},
							});
							const scrolled = yield* liveWhere(
								desk.seen,
								"both view slots written",
								(state) => state.views[only] !== undefined && state.views[second] !== undefined,
							);
							assert.deepStrictEqual(scrolled.views[only], {scroll: 0});
							assert.deepStrictEqual(scrolled.views[second], {scroll: 24});
							assert.notDeepEqual(scrolled.views[only], scrolled.views[second]);

							// One transcript, because there is one process: both windows read the state this
							// stream carries, and there is nowhere for a second copy of it to live.
							const after = yield* liveWhere(session.seen, "the session's tail", () => true);
							assert.deepStrictEqual(rendered(after), rendered(twice));
							return rendered(after);
						}),
					);
					noLiveHttp(calls);
					assert.isAtLeast(result.length, 4, "two exchanges left fewer than four items");
				}),
			),
		TIMEOUT,
	);

	it.live(
		"comes back after a restart with its transcript intact, duplicating no prompt, and answers one new prompt with exactly one new exchange",
		() =>
			run(
				Effect.gen(function* () {
					const {result, calls} = yield* withNoLiveHttp(
						Effect.gen(function* () {
							const project = freshProject();
							let before: ReadonlyArray<string> = [];
							let sessionId: string | null = null;
							let deskBefore = "";

							yield* Effect.scopedWith(
								Effect.fnUntraced(function* (scope) {
									const app = yield* Scope.provide(bootDesk(project), scope);
									const {page, desk} = yield* Scope.provide(
										attachDesk(app.server.launchUrl),
										scope,
									);
									const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
									const only = windowsOf(fresh)[0] as string;
									const opened = yield* openPiFromThePicker(desk, app.entries, only);
									const agentId = opened.processId;
									const session = yield* Scope.provide(attachSession(page, agentId), scope);
									yield* session.send({type: "start", cwd: project, resume: null});
									const ready = yield* liveWhere(
										session.seen,
										"the session to open",
										(s) => s.phase === "ready",
									);
									const once = yield* chat(session, ready, PROMPT_1, "k1");
									const state = yield* chat(session, once, PROMPT_2, "k2");
									before = rendered(state);
									sessionId = state.sessionId;
									deskBefore = JSON.stringify(yield* settled(desk.seen, opened.desk));
								}),
							);
							assert.isNotNull(sessionId, "the first boot never opened a session");

							const app = yield* bootDesk(project);
							const {page, desk} = yield* attachDesk(app.server.launchUrl);
							const restoredDesk = yield* liveWhere(desk.seen, "the first snapshot", () => true);
							assert.strictEqual(
								JSON.stringify(restoredDesk),
								deskBefore,
								"the desk did not come back as the restart left it",
							);
							const window = windowsOf(restoredDesk)[0] as string;
							const agentId = boundProcess(restoredDesk, window);
							assert.isNotNull(agentId, "the restored desk lost the window's process");

							// Nothing is dispatched into the agent here: the resume is the kernel's
							// (`../../durability/resume.ts`), so what settles is what a restart does on its own.
							const session = yield* attachSession(page, agentId as string);
							const restored = yield* liveWhere(
								session.seen,
								"the restored session to be ready",
								(s) => s.phase === "ready",
							);
							assert.strictEqual(restored.sessionId, sessionId, "the restart opened a new session");
							assert.deepStrictEqual(
								rendered(restored),
								before,
								"the restored transcript is not the one the restart interrupted",
							);

							const grown = yield* chat(session, restored, PROMPT_3, "k3");
							return {before, grown};
						}),
					);
					noLiveHttp(calls);
					const {before, grown} = result;
					assert.deepStrictEqual(
						rendered(grown).slice(0, before.length),
						before,
						"the new turn rewrote the tail it was appended to",
					);
					assert.deepStrictEqual(
						textsIn(grown).filter((text) => text === PROMPT_3),
						[PROMPT_3],
						"one deliberate prompt landed in the tail more than once",
					);
					assert.strictEqual(
						new Set(rendered(grown)).size,
						rendered(grown).length,
						"the restart duplicated an item",
					);
					// The fresh boot's provider starts at the head of its script, so the reply to the
					// post-restart prompt is `REPLY_1` again — a second item with a text the restored
					// transcript already carried, and proof the new turn is new rather than replayed.
					assert.strictEqual(replies(grown).at(-1), REPLY_1);
				}),
			),
		TIMEOUT,
	);

	it.live(
		"shows the same desk and the same transcript over a second socket after the page's own drops, and a prompt sent on it still reaches the session",
		() =>
			run(
				Effect.gen(function* () {
					const {result, calls} = yield* withNoLiveHttp(
						Effect.gen(function* () {
							const project = freshProject();
							const app = yield* bootDesk(project);
							let before: AiAgentSessionState | null = null;
							let deskBefore = "";
							let agentId = "";

							yield* Effect.scopedWith(
								Effect.fnUntraced(function* (scope) {
									const {page, desk} = yield* Scope.provide(
										attachDesk(app.server.launchUrl),
										scope,
									);
									const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
									const window = windowsOf(fresh)[0] as string;
									const opened = yield* openPiFromThePicker(desk, app.entries, window);
									agentId = opened.processId;
									const session = yield* Scope.provide(attachSession(page, agentId), scope);
									yield* session.send({type: "start", cwd: project, resume: null});
									const ready = yield* liveWhere(
										session.seen,
										"the session to open",
										(s) => s.phase === "ready",
									);
									before = yield* chat(session, ready, PROMPT_1, "k1");
									deskBefore = JSON.stringify(yield* settled(desk.seen, opened.desk));
								}),
							);
							const left = before as AiAgentSessionState | null;
							assert.isNotNull(left, "the first socket never saw a session");

							const {page, desk} = yield* attachDesk(app.server.launchUrl);
							const again = yield* liveWhere(desk.seen, "the first snapshot", () => true);
							assert.strictEqual(
								JSON.stringify(again),
								deskBefore,
								"the second socket showed a different desk",
							);
							const session = yield* attachSession(page, agentId);
							const seenAgain = yield* liveWhere(session.seen, "the session's state", () => true);
							assert.deepStrictEqual(
								rendered(seenAgain),
								rendered(left as AiAgentSessionState),
								"the re-attached page saw a different transcript",
							);
							return yield* chat(session, seenAgain, PROMPT_4, "k2");
						}),
					);
					noLiveHttp(calls);
					assert.deepStrictEqual(
						replies(result),
						[REPLY_1, REPLY_2],
						"the prompt sent over the second socket never reached the session",
					);
				}),
			),
		TIMEOUT,
	);
});

process.on("exit", () => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
