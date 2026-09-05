/**
 * The Claude vertical (#7625): one Claude chat opened in the real shell from the real picker,
 * chatted with, a card answered, the mode switched, Pi running beside it, the app stopped and
 * booted again, the page re-attached, and a child spawned through the three kernel tools.
 *
 * It is the Pi vertical (`../../pi/proof/pi-vertical.integration.test.ts`) with a `claude-session`
 * where the `pi-session` was — same kernel, same `serveDesk` socket, same page `attach`, same
 * keys-and-Msgs input vocabulary — plus the three things a Claude row has that a Pi row does not: a
 * permission card, a four-mode switch, and the kernel tools. The one substitution is the layer:
 * `ScriptedAiAgent.layer` replays `./script.ts`, so CI calls no model API and spends nothing
 * (founder ruling on #7582 and #7586). The real CLI is the founder's own local run, `./serve.ts`,
 * and no workflow reaches it.
 *
 * **Every assertion reads process state off the transport**, never off a `ProcessHandle` and never
 * off a DOM. What a window is handed is `readProcess` and `dispatch` (`../../shell/window/host.ts`);
 * this file holds exactly those two, so what it proves is what `ClaudeChatWindow` would see. The
 * permission and mode claims read `state.permissions` and `state.modes`, which are the very values
 * `../../ai-agent/handlers/publish.ts` puts on the `permissionPending` and `modeState` ports.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, type FileSystem, Queue, Result, Schema, Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import type {AiAgentSessionMsg, AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {PI_SESSION_PROGRAM} from "../../pi/renderer-ref.ts";
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
import {DEFAULT_ALLOWED_TOOLS} from "../config.ts";
import {CLAUDE_SESSION_PROGRAM} from "../renderer-ref.ts";
import {claudeTools} from "./kernel-tools.ts";
import {
	CARD,
	CHILD_PROGRAM,
	CHILD_PROMPT,
	CHILD_REPLY,
	PROJECT_ROOT_VAR,
	PROMPT_1,
	PROMPT_2,
	PROMPT_3,
	PROMPT_4,
	REPLY_1,
	REPLY_2,
	REPLY_4,
} from "./names.ts";
import {
	afterTheCut,
	afterTheFirstTurn,
	afterTheResend,
	afterTheSecondTurn,
	OFFERED,
	SESSION,
	SWITCHED_TO,
	TOOL_ITEM,
} from "./script.ts";

const TIMEOUT = 180_000;

const configModule = fileURLToPath(new URL("./desk.ts", import.meta.url));

/** The shell is spawned at its graph node's id, so the desk's process id is known before boot. */
const shellProcessId = ProcessId.make(shellNode);

const tempDirs: string[] = [];

const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-claude-vertical-")));
	tempDirs.push(dir);
	mkdirSync(projectDir(dir));
	process.env[PROJECT_ROOT_VAR] = dir;
	return dir;
};

/**
 * The whole app for one project root, built into the caller's Scope — so closing that Scope is the
 * app stopping, which is what the restart case does.
 */
const bootDesk = Effect.fn("claudeVertical.bootDesk")(function* (project: string) {
	const booted = yield* boot({global: configModule, project});
	const server = yield* serveDesk({kernel: booted.kernel, port: 0, table: defaultPrefixTable});
	const entries = yield* readEntries.pipe(Effect.provideContext(booted.kernel));
	return {booted, server, entries};
});

/**
 * Every value a stream published, in order. The queue is what a wait takes from; the log keeps what
 * a wait consumed, because "how many times did the card open and close" is a claim about the whole
 * sequence and a queue read destroys it.
 */
interface Watched<A> {
	readonly seen: Queue.Queue<A>;
	readonly log: ReadonlyArray<A>;
}

const watch = Effect.fn("claudeVertical.watch")(function* <A>(stream: Stream.Stream<A>) {
	const seen = yield* Queue.unbounded<A>();
	const log: Array<A> = [];
	yield* Effect.forkScoped(
		Stream.runForEach(stream, (value) =>
			Effect.flatMap(
				Effect.sync(() => void log.push(value)),
				() => Effect.asVoid(Queue.offer(seen, value)),
			),
		),
	);
	return {seen, log} satisfies Watched<A>;
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
 * gone past blocks until the timeout. This is the read for "what does it look like *now*".
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
const attachDesk = Effect.fn("claudeVertical.attachDesk")(function* (url: string) {
	const page = yield* attach(url).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));
	const shell = yield* page.attachProcess<ShellState, ShellMsg>(shellProcessId);
	const watched = yield* watch(shell.readProcess);
	const rows = yield* watch(page.rows);
	const desk: Desk = {send: (msg) => Effect.asVoid(shell.dispatch(msg)), seen: watched.seen};
	return {page, desk, rows: rows.seen};
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

/** Walk the picker's highlight onto one program row and choose it, one real `pickerKey` answer per step. */
const openFromThePicker = Effect.fn("claudeVertical.openFromThePicker")(function* (
	desk: Desk,
	entries: PickerEntries,
	windowId: string,
	programId: string,
) {
	const at = entries.programs.findIndex((entry) => entry.programId === programId);
	assert.isAtLeast(at, 0, `the picker offers the ${programId} program`);
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
		`the window bound to a ${programId} process`,
		(state) => boundProcess(state, windowId) !== null,
	);
	return {processId: boundProcess(opened, windowId) as string, desk: opened};
});

/** The transcript as a window renders it: `kind:id` per item, which is what a rendered row is keyed by. */
const rendered = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.map((item) => `${item.kind}:${item.id}`);

/** Just the ids, in order — what `./script.ts`'s `afterThe…` lists are written as. */
const ids = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.map((item) => item.id as string);

const textsIn = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) =>
		item.kind === "user" || item.kind === "assistant" ? [item.text] : [],
	);

const replies = (state: AiAgentSessionState): ReadonlyArray<string> =>
	state.transcript.items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));

/** The cards open right now: exactly the `pending` payload the `permissionPending` port carries. */
const openCards = (state: AiAgentSessionState): ReadonlyArray<string> =>
	Object.keys(state.permissions);

const toolStatus = (state: AiAgentSessionState, item: string): string | null => {
	for (const one of state.transcript.items) {
		if (one.id === item && one.kind === "tool") return one.status;
	}
	return null;
};

interface Session {
	readonly processId: ProcessId;
	readonly seen: Queue.Queue<ProcessView<AiAgentSessionState>>;
	readonly log: ReadonlyArray<ProcessView<AiAgentSessionState>>;
	readonly send: (msg: AiAgentSessionMsg) => Effect.Effect<void>;
}

const attachSession = Effect.fn("claudeVertical.attachSession")(function* (
	page: PageAttachment,
	processId: string,
) {
	const id = ProcessId.make(processId);
	const process = yield* page.attachProcess<AiAgentSessionState, AiAgentSessionMsg>(id);
	const watched = yield* watch(process.readProcess);
	return {
		processId: id,
		seen: watched.seen,
		log: watched.log,
		send: (msg: AiAgentSessionMsg) => Effect.asVoid(process.dispatch(msg)),
	} satisfies Session;
});

/**
 * One prompt and the one reply it must produce.
 *
 * The wait is on the reply *count* rather than on the phase, because a turn can end with the core
 * still at `prompting`, and on the count rather than on the reply's text, because a boot's script
 * starts at the head — the same text can legitimately appear twice in one transcript across a
 * restart, and a text match would have passed on the older copy.
 */
const chat = Effect.fn("claudeVertical.chat")(function* (
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
 * How many times a card went from open to closed across every frame the page was shown. One card
 * answered once is one closing; the layer's `permission-resolved` is the only thing that produces
 * one, so this counts resolutions without reaching past the transport for the event itself.
 */
const closings = (
	log: ReadonlyArray<ProcessView<AiAgentSessionState>>,
	request: string,
): number => {
	let open = false;
	let closed = 0;
	for (const view of log) {
		if (view._tag !== "Live") continue;
		const now = openCards(view.state).includes(request);
		if (open && !now) closed += 1;
		open = now;
	}
	return closed;
};

/** A tool handler that rejected. It cannot on this path — `../tools/server.ts` catches every bridge
 * refusal into an `isError` result — so a rejection is a defect, and this is what names it. */
class ToolCallRejected extends Schema.TaggedError<ToolCallRejected>()(
	"tuval/claude-vertical-proof/ToolCallRejected",
	{tool: Schema.String, detail: Schema.String},
) {
	override get message(): string {
		return `the ${this.tool} tool handler rejected: ${this.detail}`;
	}
}

/** One handler call, as the model's own runtime would make it: a promise in, its answer out. */
const callTool = <A>(tool: string, run: () => Promise<A>): Effect.Effect<A> =>
	Effect.tryPromise({
		try: run,
		catch: (cause) => new ToolCallRejected({tool, detail: String(cause)}),
	}).pipe(Effect.orDie);

/** One tool answer as JSON, with the SDK's own result type left unnamed — the proof imports none. */
const answered = (result: {
	readonly content: ReadonlyArray<{readonly type: string; readonly text?: string}>;
	readonly isError?: boolean;
}): unknown => {
	assert.notStrictEqual(result.isError, true, `a kernel tool refused: ${JSON.stringify(result)}`);
	const first = result.content[0];
	assert.isDefined(first, "a kernel tool answered with no content");
	assert.strictEqual((first as {readonly type: string}).type, "text");
	return JSON.parse((first as {readonly text: string}).text);
};

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

describe("a Claude session in the Tuval shell, end to end", () => {
	it.live(
		"opens from the picker under the shell, runs a tool row to settled, answers one card, switches mode, and shows one transcript in two windows with two view slots",
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
							assert.deepStrictEqual(
								app.entries.programs
									.map((entry) => entry.programId as string)
									.filter((id) => id === CLAUDE_SESSION_PROGRAM || id === PI_SESSION_PROGRAM)
									.toSorted(),
								[CLAUDE_SESSION_PROGRAM, PI_SESSION_PROGRAM].toSorted(),
								"the picker does not list claude-session beside pi-session",
							);

							const {processId: agentId} = yield* openFromThePicker(
								desk,
								app.entries,
								only,
								CLAUDE_SESSION_PROGRAM,
							);

							// The picker spawns under the shell (`../../shell/picker/open.ts`), and the wire
							// row is where that parentage is readable without touching a handle.
							const table = yield* where(rows, "the agent's row in the process table", (list) =>
								list.some((row: TableRow) => row.id === agentId),
							);
							const row = table.find((entry: TableRow) => entry.id === agentId) as TableRow;
							assert.strictEqual(row.programId, CLAUDE_SESSION_PROGRAM);
							assert.strictEqual(
								row.parentId._tag === "Some" ? row.parentId.value : null,
								shellProcessId,
								"the picker opened the Claude process under some other parent",
							);
							assert.lengthOf(
								table.filter((entry: TableRow) => entry.programId === CLAUDE_SESSION_PROGRAM),
								1,
								"one choice opened more than one Claude process",
							);

							const session = yield* attachSession(page, agentId);
							// The layer announces its modes on its own event, which is a later frame than the
							// one that carried `ready` — so both are waited for at once rather than the mode
							// list being read off the open, where it is still empty.
							const ready = yield* liveWhere(
								session.seen,
								"the session to open and advertise its modes",
								(s) => s.phase === "ready" && s.modes.available.length > 0,
							);
							assert.strictEqual(ready.sessionId, SESSION);
							assert.strictEqual(ready.cwd, project, "the session opened outside the project root");
							assert.deepStrictEqual(
								ready.modes.available,
								OFFERED,
								"the row did not advertise the four modes its config fixes",
							);

							// Turn one: the tool row runs and then settles under one item id.
							const once = yield* chat(session, ready, PROMPT_1, "k1");
							assert.deepStrictEqual(ids(once), afterTheFirstTurn);
							assert.strictEqual(
								toolStatus(once, TOOL_ITEM),
								"ok",
								"the tool row never settled; a window would still be showing it running",
							);
							assert.deepStrictEqual(replies(once), [REPLY_1]);

							// Turn two raises the card. The turn finishes either way; answering it is the
							// operator's move, and the card stays open until they make it.
							const twice = yield* chat(session, once, PROMPT_2, "k2");
							assert.deepStrictEqual(ids(twice), afterTheSecondTurn);
							assert.deepStrictEqual(
								openCards(twice),
								[CARD],
								"the turn's permission request never reached the port the card renders from",
							);

							yield* session.send({type: "answer", request: CARD, decision: "allow-once"});
							const answeredCard = yield* liveWhere(
								session.seen,
								"the answered card to leave the permission port",
								(s) => !openCards(s).includes(CARD),
							);
							assert.deepStrictEqual(openCards(answeredCard), []);
							assert.isNull(
								answeredCard.failure,
								"answering the card the turn raised was recorded as a refusal",
							);

							yield* session.send({type: "setMode", mode: SWITCHED_TO});
							const switched = yield* liveWhere(
								session.seen,
								"the mode switch to round-trip",
								(s) => s.modes.current === SWITCHED_TO,
							);
							assert.deepStrictEqual(switched.modes, {
								current: SWITCHED_TO,
								available: OFFERED,
							});

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
								"both windows on the Claude process",
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
							const after = yield* settled(session.seen, switched);
							assert.deepStrictEqual(rendered(after), rendered(switched));
							return {tail: ids(after), closed: closings(session.log, CARD)};
						}),
					);
					noLiveHttp(calls);
					assert.deepStrictEqual(result.tail, afterTheSecondTurn);
					assert.strictEqual(
						result.closed,
						1,
						"one answered card did not resolve exactly once on the permission port",
					);
				}),
			),
		TIMEOUT,
	);

	it.live(
		"runs Pi in one split and Claude in the other under one shell, with table rows that differ only by program id and state summary",
		() =>
			run(
				Effect.gen(function* () {
					const {result, calls} = yield* withNoLiveHttp(
						Effect.gen(function* () {
							const project = freshProject();
							const app = yield* bootDesk(project);
							const {desk, rows} = yield* attachDesk(app.server.launchUrl);

							const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
							const first = windowsOf(fresh)[0] as string;
							const claude = yield* openFromThePicker(
								desk,
								app.entries,
								first,
								CLAUDE_SESSION_PROGRAM,
							);

							yield* press(desk, "<c-b>", "|");
							const split = yield* liveWhere(
								desk.seen,
								"a second window",
								(state) => windowsOf(state).length === 2,
							);
							const second = windowsOf(split).find((id) => id !== first) as string;
							assert.isDefined(second);
							const pi = yield* openFromThePicker(desk, app.entries, second, PI_SESSION_PROGRAM);
							assert.notStrictEqual(
								pi.processId,
								claude.processId,
								"the second window bound the process the first one opened",
							);

							const table = yield* where(rows, "both agent rows in the process table", (list) =>
								[claude.processId, pi.processId].every((id) =>
									list.some((row: TableRow) => row.id === id),
								),
							);
							const rowOf = (id: string): TableRow =>
								table.find((entry: TableRow) => entry.id === id) as TableRow;
							return {claude: rowOf(claude.processId), pi: rowOf(pi.processId)};
						}),
					);
					noLiveHttp(calls);
					const {claude, pi} = result;
					assert.strictEqual(claude.programId, CLAUDE_SESSION_PROGRAM);
					assert.strictEqual(pi.programId, PI_SESSION_PROGRAM);
					assert.deepStrictEqual(
						claude.parentId,
						pi.parentId,
						"the two agents came up under different parents",
					);
					assert.strictEqual(
						claude.parentId._tag === "Some" ? claude.parentId.value : null,
						shellProcessId,
					);
					assert.deepStrictEqual(
						claude.ports,
						pi.ports,
						"the two rows declare different ports, so a projection could tell them apart by shape",
					);
					// The row's whole surface, minus the two axes a reader is allowed to tell them apart by
					// and the id every process has. Nothing may be left over: a row that grew a
					// program-specific field would land here and redden.
					const {
						id: _claudeId,
						programId: _claudeProgram,
						stateSummary: _claudeState,
						...restOfClaude
					} = claude;
					const {id: _piId, programId: _piProgram, stateSummary: _piState, ...restOfPi} = pi;
					assert.deepStrictEqual(
						restOfClaude,
						restOfPi,
						"a Pi row and a Claude row differ by something other than program id and state summary",
					);
				}),
			),
		TIMEOUT,
	);

	it.live(
		"comes back after a restart with its transcript intact and the cut turn interrupted, duplicating no prompt, and answers one resend with exactly one new exchange",
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
									const opened = yield* openFromThePicker(
										desk,
										app.entries,
										only,
										CLAUDE_SESSION_PROGRAM,
									);
									const session = yield* Scope.provide(
										attachSession(page, opened.processId),
										scope,
									);
									const ready = yield* liveWhere(
										session.seen,
										"the session to open",
										(s) => s.phase === "ready",
									);
									const once = yield* chat(session, ready, PROMPT_1, "k1");
									yield* chat(session, once, PROMPT_2, "k2");

									// The third turn writes half a reply and never reports `ready`. Waiting on
									// the committed item is what makes the stop land inside it.
									yield* session.send({type: "prompt", text: PROMPT_3, key: "k3"});
									const cut = yield* liveWhere(
										session.seen,
										"the cut turn's half-written reply",
										(s) => ids(s).includes("a3"),
									);
									before = ids(cut);
									sessionId = cut.sessionId;
									deskBefore = JSON.stringify(yield* settled(desk.seen, opened.desk));
								}),
							);
							assert.strictEqual(sessionId, SESSION, "the first boot never opened the session");
							assert.deepStrictEqual(
								before,
								afterTheCut,
								"the first boot's tail is not the cut tail",
							);

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
								ids(restored),
								afterTheCut,
								"the restored transcript is not the one the restart interrupted",
							);
							assert.strictEqual(
								restored.interrupted,
								"a3",
								"the cut turn came back unmarked, so no window could offer the resend",
							);

							// Not `chat`: the resend answers the prompt the restart cut, so its turn carries no
							// user item and the tail must not grow a second copy of `u3`. What one deliberate
							// send has to produce is one reply, and that is what is waited for.
							const was = replies(restored).length;
							yield* session.send({type: "prompt", text: PROMPT_4, key: "k4"});
							const grown = yield* liveWhere(
								session.seen,
								`the reply to the resend "${PROMPT_4}"`,
								(s) => replies(s).length > was,
							);
							assert.strictEqual(
								replies(grown).length,
								was + 1,
								`one resend produced ${replies(grown).length - was} replies`,
							);
							return {before, grown};
						}),
					);
					noLiveHttp(calls);
					const {before, grown} = result;
					assert.deepStrictEqual(ids(grown), afterTheResend);
					assert.deepStrictEqual(
						ids(grown).slice(0, before.length),
						before,
						"the new turn rewrote the tail it was appended to",
					);
					assert.deepStrictEqual(
						textsIn(grown).filter((text) => text === PROMPT_3),
						[PROMPT_3],
						"one deliberate prompt landed in the tail more than once",
					);
					assert.strictEqual(
						new Set(ids(grown)).size,
						ids(grown).length,
						"the restart duplicated an item",
					);
					assert.strictEqual(replies(grown).at(-1), REPLY_4);
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
									const opened = yield* openFromThePicker(
										desk,
										app.entries,
										window,
										CLAUDE_SESSION_PROGRAM,
									);
									agentId = opened.processId;
									const session = yield* Scope.provide(attachSession(page, agentId), scope);
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
								ids(seenAgain),
								ids(left as AiAgentSessionState),
								"the re-attached page saw a different transcript",
							);
							return yield* chat(session, seenAgain, PROMPT_2, "k2");
						}),
					);
					noLiveHttp(calls);
					assert.deepStrictEqual(
						replies(result),
						[REPLY_1, REPLY_2],
						"the prompt sent over the second socket never reached the session",
					);
					assert.deepStrictEqual(ids(result), afterTheSecondTurn);
				}),
			),
		TIMEOUT,
	);

	it.live(
		"spawns a child under itself through the spawn tool handler, and round-trips a prompt to that child's own ports with send and read",
		() =>
			run(
				Effect.gen(function* () {
					const {result, calls} = yield* withNoLiveHttp(
						Effect.gen(function* () {
							const project = freshProject();
							const app = yield* bootDesk(project);
							const {desk, rows} = yield* attachDesk(app.server.launchUrl);

							const fresh = yield* liveWhere(desk.seen, "the first snapshot", () => true);
							const window = windowsOf(fresh)[0] as string;
							const opened = yield* openFromThePicker(
								desk,
								app.entries,
								window,
								CLAUDE_SESSION_PROGRAM,
							);

							const workspace = workspaceOf(fresh).id as string;
							const tools = yield* claudeTools({
								kernel: app.booted.kernel,
								window,
								process: ProcessId.make(opened.processId),
								workspace,
								client: "claude-vertical-proof",
							});
							// The row's config auto-allows exactly the names this server registers; a drift
							// between them is a tool the model would be asked for a card on, or one it could
							// not call at all.
							assert.deepStrictEqual(tools.wireNames, DEFAULT_ALLOWED_TOOLS);

							const spawned = answered(
								yield* callTool("spawn", () => tools.handlers.spawn({program: CHILD_PROGRAM})),
							) as {readonly process: string};
							assert.isString(spawned.process, "the spawn tool answered without a process id");

							const table = yield* where(rows, "the child's row in the process table", (list) =>
								list.some((row: TableRow) => row.id === spawned.process),
							);
							const child = table.find(
								(entry: TableRow) => entry.id === spawned.process,
							) as TableRow;

							const sent = answered(
								yield* callTool("send", () =>
									tools.handlers.send({
										process: spawned.process,
										port: "prompt",
										payload: {text: CHILD_PROMPT, key: "child-1"},
									}),
								),
							) as {readonly delivered: boolean};

							// `read` answers the port's current value, so it is polled rather than waited on:
							// the transcript is published before the prompt lands and again after the reply.
							const transcript = yield* Effect.gen(function* () {
								for (let attempt = 0; attempt < 200; attempt += 1) {
									const held = answered(
										yield* callTool("read", () =>
											tools.handlers.read({process: spawned.process, port: "transcript"}),
										),
									) as {readonly empty: boolean; readonly value?: {readonly items?: unknown}};
									const items = held.empty
										? []
										: ((held.value?.items ?? []) as ReadonlyArray<{
												readonly kind: string;
												readonly text?: string;
											}>);
									if (items.some((item) => item.text === CHILD_REPLY)) return items;
									yield* Effect.sleep("25 millis");
								}
								return yield* Effect.die(
									new Error(`the child's transcript port never carried "${CHILD_REPLY}"`),
								);
							});

							return {child, claudeId: opened.processId, delivered: sent.delivered, transcript};
						}),
					);
					noLiveHttp(calls);
					assert.isTrue(result.delivered, "the child's prompt port refused the payload");
					assert.strictEqual(result.child.programId, CHILD_PROGRAM);
					assert.strictEqual(
						result.child.parentId._tag === "Some" ? result.child.parentId.value : null,
						result.claudeId,
						"the spawn tool started the child under some other parent",
					);
					assert.deepStrictEqual(
						result.transcript.map((item) => item.text),
						[CHILD_PROMPT, CHILD_REPLY],
						"the child's transcript port did not carry the prompt send put on it and the reply it produced",
					);
				}),
			),
		TIMEOUT,
	);
});

process.on("exit", () => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
