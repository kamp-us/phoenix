/**
 * The shell end to end (#7560): a real kernel over a real file store, a real WebSocket, and the
 * demo programs of #7517 — driven by nothing but keys, then stopped and booted again, then
 * re-attached. The three proofs are the ticket's three, in that order, in one test each.
 *
 * Two rules hold across all of them. **Every assertion reads shell state off the transport**, never
 * off the shell process's handle and never off a DOM: the page's view of the desk is the thing
 * under test, so reading around it would prove a different system. And **the only input is a key**
 * — `keys.press` for everything the prefix table binds, plus the two Msgs a *surface* derives from
 * a key and no kernel can (the picker's chosen row and the command line's read), each produced by
 * the very function the browser surface calls (`../picker/view.ts`, `../commands/line.ts`).
 */

import {randomBytes} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {request} from "node:http";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Queue, Result, Schema, Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {start} from "../../boot.ts";
import {counterNode, demoGraph, demoPrograms} from "../../demo/index.ts";
import {logId} from "../../demo/log.ts";
import {LAUNCH_ENDPOINT, servePage} from "../../page/dev-server.ts";
import {ProcessId} from "../../process/process.ts";
import {readCommandLine} from "../commands/index.ts";
import {activeWorkspace, type ShellMsg, type ShellState, windowIds} from "../core/index.ts";
import {wiredShellEffects} from "../host/effects.ts";
import {serveDesk} from "../host/serve.ts";
import {type Key, parse} from "../keys/index.ts";
import {windows} from "../layout/index.ts";
import {
	mountPicker,
	type PickerEntries,
	type PickerView,
	pickerKey,
	readEntries,
} from "../picker/index.ts";
import {shellGraphNode, shellNode, shellProgram} from "../program.ts";
import {attach} from "../transport/client.ts";
import type {ProcessView} from "../window/index.ts";

const TIMEOUT = 90_000;

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const tempDir = Effect.acquireRelease(
	io(() => mkdtemp(join(tmpdir(), "tuval-shell-e2e-"))),
	(dir) => Effect.ignore(io(() => rm(dir, {recursive: true, force: true}))),
);

/** The shell is spawned at its graph node's id, so the desk's process id is known before boot. */
const shellProcessId = ProcessId.make(shellNode);
/** Likewise the counter's: a planned node's process carries the node's own id. */
const counterProcessId = ProcessId.make(counterNode);

/**
 * One whole app: the shell row wired to the kernel, the two demo programs with a probe behind the
 * log's `write` and no timer, and the socket the page attaches over. Built into the caller's Scope,
 * so closing that Scope is the app stopping — which is what the restart proof does.
 */
const bootDesk = Effect.fn("proof.bootDesk")(function* (stateDir: string) {
	const lines = yield* Queue.unbounded<string>();
	const programs = [
		shellProgram({effects: wiredShellEffects({shellProcessId})}),
		...demoPrograms({everyMs: null, write: (line) => Effect.asVoid(Queue.offer(lines, line))}),
	];
	const started = yield* start({
		programs,
		graph: {nodes: [shellGraphNode, ...demoGraph.nodes]},
		stateDir,
	});
	const server = yield* serveDesk({kernel: started.kernel, port: 0});
	const entries = yield* readEntries.pipe(Effect.provideContext(started.kernel));
	return {started, server, lines, entries};
});

const openPage = (url: string) =>
	attach(url).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));

/** `apps/tuval` — `index.html`'s home, and so the page server's root, as `bin.ts` computes it. */
const appRoot = dirname(dirname(dirname(import.meta.dirname)));

/**
 * Replay the WebSocket upgrade by hand and answer with its status line: 101 admitted, 401 refused
 * by `verifyClient` before any frame. Hand-rolled because a Node WebSocket client sends no `Origin`
 * — the one input the fence lets through unconditionally — so nothing that attaches the way the
 * other proofs do can exercise the check a browser actually meets (#7560).
 */
const upgradeStatus = (launchUrl: string, origin: string | undefined) =>
	Effect.callback<number>((resume) => {
		const target = new URL(launchUrl);
		const attempt = request({
			hostname: target.hostname,
			port: Number(target.port),
			path: `${target.pathname}${target.search}`,
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-key": randomBytes(16).toString("base64"),
				"sec-websocket-version": "13",
				...(origin === undefined ? {} : {origin}),
			},
		});
		attempt.on("upgrade", (response, socket) => {
			socket.destroy();
			resume(Effect.succeed(response.statusCode ?? 0));
		});
		attempt.on("response", (response) => {
			response.resume();
			resume(Effect.succeed(response.statusCode ?? 0));
		});
		attempt.on("error", (cause) => resume(Effect.die(cause)));
		attempt.end();
	});

/** Every state the shell publishes, in order, so a read proves the subscription is live. */
const watchDesk = Effect.fn("proof.watchDesk")(function* (
	stream: Stream.Stream<ProcessView<ShellState>>,
) {
	const seen = yield* Queue.unbounded<ProcessView<ShellState>>();
	yield* Effect.forkScoped(
		Stream.runForEach(stream, (view) => Effect.asVoid(Queue.offer(seen, view))),
	);
	return seen;
});

/**
 * The next desk that satisfies `predicate`. A dispatch is acknowledged when the Msg reaches the
 * actor, and the state frame that follows it is a separate write on the same socket, so waiting for
 * the state rather than for the ack is the only read that cannot see a desk from before the key.
 */
const deskWhere = (
	seen: Queue.Queue<ProcessView<ShellState>>,
	what: string,
	predicate: (state: ShellState) => boolean,
) => {
	let last: ShellState | null = null;
	return Effect.gen(function* () {
		while (true) {
			const view = yield* Queue.take(seen);
			if (view._tag !== "Live") continue;
			last = view.state;
			if (predicate(view.state)) return view.state;
		}
	}).pipe(
		Effect.timeout("30 seconds"),
		// The desk that never arrived is the whole diagnosis, so the last one that did is in the
		// failure rather than a bare TimeoutError.
		Effect.catchTag("TimeoutError", () =>
			Effect.die(new Error(`no desk where ${what}; last seen: ${JSON.stringify(last)}`)),
		),
	);
};

/** The next line the log program wrote. An effect that never arrives is a failure, not a hang. */
const nextLine = (lines: Queue.Queue<string>, what: string) =>
	Queue.take(lines).pipe(
		Effect.timeout("30 seconds"),
		Effect.catchTag("TimeoutError", () => Effect.die(new Error(`no effect: ${what}`))),
	);

const workspaceOf = (state: ShellState) => {
	const workspace = activeWorkspace(state);
	assert.isDefined(workspace, "the desk has an active workspace");
	return workspace;
};

const windowsOf = (state: ShellState): readonly string[] => windowIds(workspaceOf(state));
const focusOf = (state: ShellState): string => workspaceOf(state).focused;
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

/** Press keys, in order — the whole input vocabulary of the keys-only proof. */
const press = (desk: Desk, ...spellings: ReadonlyArray<string>) =>
	Effect.forEach(spellings, (spelling) => desk.send({type: "keys.press", key: keyOf(spelling)}), {
		concurrency: 1,
		discard: true,
	});

/**
 * The repeat window's countdown, fired by hand. `startRepeatTimer` is a Cmd the kernel cannot run —
 * a handler returns its follow-ups and cannot dispatch one later — so the page owns that countdown
 * off the window's length in the snapshot (`../ui/Desk.tsx`). A repeatable binding (`<c-h>`,
 * `<c-l>`) deliberately leaves the prefix armed for it, so a proof driving the kernel with no page
 * in it has to be that countdown itself. A prefix armed by hand needs none: it waits indefinitely
 * (#7842) until a sequence fires or Escape drops it.
 */
const disarm = (desk: Desk) => desk.send({type: "prefix.repeatLapsed"});

/** A page attached to the shell process, with its state stream already running. */
const attachDesk = Effect.fn("proof.attachDesk")(function* (url: string) {
	const page = yield* openPage(url);
	const shell = yield* page.attachProcess<ShellState, ShellMsg>(shellProcessId);
	const seen = yield* watchDesk(shell.readProcess);
	const desk: Desk = {send: (msg) => Effect.asVoid(shell.dispatch(msg)), seen};
	return {page, desk};
});

/**
 * The picker's own answer to a key, turned into the Msg the browser surface would dispatch
 * (`../ui/PickerView.tsx` does exactly this switch). Driving the real `pickerKey` is what makes
 * "opened from the picker" a claim about the picker rather than about a hand-written Msg.
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

describe("the Tuval shell, end to end", () => {
	it.live(
		"a scripted key sequence splits, walks focus, switches workspaces, opens demo programs both ways and shows one process in two windows — every assertion read off the transport",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;
				const app = yield* bootDesk(stateDir);
				const {desk} = yield* attachDesk(app.server.launchUrl);

				const fresh = yield* deskWhere(desk.seen, "the first snapshot", () => true);
				assert.lengthOf(windowsOf(fresh), 1);
				assert.isFalse(fresh.prefix.armed);

				yield* press(desk, "<c-b>", "|");
				const split = yield* deskWhere(
					desk.seen,
					"two windows",
					(state) => windowsOf(state).length === 2,
				);
				yield* press(desk, "<c-b>", "-");
				const three = yield* deskWhere(
					desk.seen,
					"three windows",
					(state) => windowsOf(state).length === 3,
				);
				const [left, upper, lower] = windowsOf(three);
				assert.isDefined(left);
				assert.isDefined(upper);
				assert.isDefined(lower);
				// A split focuses what it made: the desk is `left | (upper / lower)` with `lower` focused.
				assert.strictEqual(focusOf(split), windowsOf(split)[1]);
				assert.strictEqual(focusOf(three), lower);

				yield* press(desk, "<c-b>", "k");
				assert.strictEqual(
					focusOf(
						yield* deskWhere(desk.seen, "focus on the upper window", (s) => focusOf(s) === upper),
					),
					upper,
				);
				yield* press(desk, "<c-b>", "h");
				assert.strictEqual(
					focusOf(
						yield* deskWhere(desk.seen, "focus on the left window", (s) => focusOf(s) === left),
					),
					left,
				);
				yield* press(desk, "<c-b>", "l");
				const rightward = yield* deskWhere(
					desk.seen,
					"focus off the left window",
					(s) => focusOf(s) !== left,
				);
				assert.include([upper, lower], focusOf(rightward));
				yield* press(desk, "<c-b>", "<arrowdown>");
				assert.strictEqual(
					focusOf(
						yield* deskWhere(desk.seen, "focus on the lower window", (s) => focusOf(s) === lower),
					),
					lower,
				);

				yield* press(desk, "<c-b>", "N");
				const second = yield* deskWhere(
					desk.seen,
					"a second workspace",
					(state) => state.order.length === 2,
				);
				assert.strictEqual(second.activeWorkspace, second.order[1]);
				assert.lengthOf(windowsOf(second), 1);
				yield* press(desk, "<c-b>", "<c-h>");
				yield* disarm(desk);
				const back = yield* deskWhere(
					desk.seen,
					"the first workspace active",
					(state) => state.activeWorkspace === second.order[0],
				);
				assert.lengthOf(windowsOf(back), 3);

				// Window one: the picker. Move the highlight onto the log row and choose it.
				const logAt = app.entries.programs.findIndex((entry) => entry.programId === logId);
				assert.isAtLeast(logAt, 0, "the log program is offered by the picker");
				yield* desk.send({type: "window.focus", windowId: left as never});
				yield* deskWhere(
					desk.seen,
					"focus back on the left window",
					(state) => focusOf(state) === left,
				);
				let view = mountPicker();
				for (let step = 0; step < logAt; step++) {
					const msg = pickerPress(left, app.entries, view, "j");
					assert.isNotNull(msg);
					view = {cursor: view.cursor + 1, refusal: null};
					yield* desk.send(msg as ShellMsg);
				}
				const chosen = pickerPress(left, app.entries, view, "<enter>");
				assert.isNotNull(chosen);
				yield* desk.send(chosen as ShellMsg);
				const opened = yield* deskWhere(
					desk.seen,
					"the left window bound",
					(state) => boundProcess(state, left) !== null,
				);
				const firstLog = boundProcess(opened, left);
				assert.isNotNull(firstLog);

				// Window two: `prefix :` opens the command line, and the line the founder types is read
				// by the same reader the surface calls.
				yield* desk.send({type: "window.focus", windowId: upper as never});
				yield* deskWhere(
					desk.seen,
					"focus on the upper window",
					(state) => focusOf(state) === upper,
				);
				yield* press(desk, "<c-b>", ":");
				const line = readCommandLine(`window:open ${logId}`);
				assert.strictEqual(line._tag, "Msg");
				yield* desk.send((line as {readonly msg: ShellMsg}).msg);
				const typed = yield* deskWhere(
					desk.seen,
					"the upper window bound",
					(state) => boundProcess(state, upper) !== null,
				);
				const secondLog = boundProcess(typed, upper);
				assert.isNotNull(secondLog);
				assert.notStrictEqual(secondLog, firstLog, "two opens are two processes");

				// One process, two windows, two view slots. `lower` splits so there is a second window
				// to show the counter in, and both are attached to the process the graph already runs.
				yield* desk.send({type: "window.focus", windowId: lower as never});
				yield* deskWhere(
					desk.seen,
					"focus on the lower window",
					(state) => focusOf(state) === lower,
				);
				yield* press(desk, "<c-b>", "|");
				const four = yield* deskWhere(
					desk.seen,
					"four windows",
					(state) => windowsOf(state).length === 4,
				);
				const fourth = windowsOf(four).find(
					(id) => id !== left && id !== upper && id !== lower,
				) as string;
				assert.isDefined(fourth);
				yield* desk.send({
					type: "window.attach",
					windowId: lower as never,
					processId: counterProcessId,
				});
				yield* desk.send({
					type: "window.attach",
					windowId: fourth as never,
					processId: counterProcessId,
				});
				const shared = yield* deskWhere(
					desk.seen,
					"the counter in two windows",
					(state) =>
						boundProcess(state, lower) === counterProcessId &&
						boundProcess(state, fourth) === counterProcessId,
				);
				assert.strictEqual(boundProcess(shared, lower), boundProcess(shared, fourth));

				yield* desk.send({type: "window.setView", windowId: lower as never, view: {scroll: 0}});
				yield* desk.send({type: "window.setView", windowId: fourth as never, view: {scroll: 12}});
				const scrolled = yield* deskWhere(
					desk.seen,
					"both view slots written",
					(state) => state.views[lower] !== undefined && state.views[fourth] !== undefined,
				);
				assert.deepStrictEqual(scrolled.views[lower], {scroll: 0});
				assert.deepStrictEqual(scrolled.views[fourth], {scroll: 12});
				assert.notDeepEqual(scrolled.views[lower], scrolled.views[fourth]);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"stopping the app and booting it again brings back the desk byte-equal and every process with it, duplicating no effect, and one new key yields exactly one new effect",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;
				let before = "";
				let logProcess = "";

				yield* Effect.scopedWith(
					Effect.fnUntraced(function* (scope) {
						const app = yield* Scope.provide(bootDesk(stateDir), scope);
						const {desk} = yield* Scope.provide(attachDesk(app.server.launchUrl), scope);
						yield* deskWhere(desk.seen, "the first snapshot", () => true);
						yield* press(desk, "<c-b>", "|", "<c-b>", "N", "<c-b>", "<c-h>");
						yield* disarm(desk);
						const ready = yield* deskWhere(
							desk.seen,
							"two workspaces and two windows",
							(state) => state.order.length === 2 && windowsOf(state).length === 2,
						);
						const [first] = windowsOf(ready);
						assert.isDefined(first);
						yield* desk.send({type: "window.open", windowId: first as never, programId: logId});
						const opened = yield* deskWhere(
							desk.seen,
							"the first window bound",
							(state) => boundProcess(state, first) !== null,
						);
						logProcess = boundProcess(opened, first) ?? "";
						before = JSON.stringify(opened);

						yield* desk.send({type: "window.focus", windowId: first as never});
						yield* deskWhere(
							desk.seen,
							"focus on the first window",
							(state) => focusOf(state) === first,
						);
						yield* press(desk, "a");
						assert.strictEqual(yield* nextLine(app.lines, "key a from the first boot"), "key a");
						before = JSON.stringify(
							yield* deskWhere(
								desk.seen,
								"focus on the first window",
								(state) => focusOf(state) === first,
							),
						);
					}),
				);

				const app = yield* bootDesk(stateDir);
				const {desk} = yield* attachDesk(app.server.launchUrl);
				const restored = yield* deskWhere(desk.seen, "the first snapshot", () => true);
				assert.strictEqual(JSON.stringify(restored), before, "the desk comes back byte-equal");

				// The shell and the counter/log the graph plans come back as launched-and-restored; the
				// process the picker spawned is not in the graph, so `restore` is what brings it back.
				assert.deepStrictEqual(
					app.started.launched.map((one) => [one.node, one.restored]),
					[
						["shell", true],
						["counter", true],
						["log", true],
					],
				);
				assert.deepStrictEqual(
					app.started.restored.map((handle) => handle.id),
					[logProcess],
				);
				assert.strictEqual(yield* Queue.size(app.lines), 0, "a boot replays no effect");

				const first = windowsOf(restored)[0] as string;
				yield* desk.send({type: "window.focus", windowId: first as never});
				yield* deskWhere(
					desk.seen,
					"focus on the first window",
					(state) => focusOf(state) === first,
				);
				yield* press(desk, "b");
				assert.strictEqual(yield* nextLine(app.lines, "key b after the restart"), "key b");
				assert.strictEqual(yield* Queue.size(app.lines), 0, "one input, one effect");
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"dropping the page's socket and attaching again shows the same desk, and a key forwarded to a window reaches its process",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;
				const app = yield* bootDesk(stateDir);
				let before = "";
				let window = "";

				yield* Effect.scopedWith(
					Effect.fnUntraced(function* (scope) {
						const {desk} = yield* Scope.provide(attachDesk(app.server.launchUrl), scope);
						yield* deskWhere(desk.seen, "the first snapshot", () => true);
						yield* press(desk, "<c-b>", "|");
						const two = yield* deskWhere(
							desk.seen,
							"two windows",
							(state) => windowsOf(state).length === 2,
						);
						window = focusOf(two);
						yield* desk.send({type: "window.open", windowId: window as never, programId: logId});
						before = JSON.stringify(
							yield* deskWhere(
								desk.seen,
								"the window bound",
								(state) => boundProcess(state, window) !== null,
							),
						);
					}),
				);

				const {desk} = yield* attachDesk(app.server.launchUrl);
				const again = yield* deskWhere(desk.seen, "the first snapshot", () => true);
				assert.strictEqual(JSON.stringify(again), before, "the same desk, over a second socket");
				assert.strictEqual(focusOf(again), window);

				yield* press(desk, "c");
				assert.strictEqual(yield* nextLine(app.lines, "key c after re-attaching"), "key c");
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"the served page can attach: the launch endpoint answers the socket's URL and the upgrade carrying the page's own Origin is admitted, while a foreign one is refused",
		() =>
			Effect.gen(function* () {
				const stateDir = yield* tempDir;
				const app = yield* bootDesk(stateDir);
				const page = yield* servePage({root: appRoot, transport: app.server, port: 0});
				assert.notStrictEqual(page.port, app.server.port, "the page and the socket bind two ports");

				const answered = yield* io(() =>
					fetch(new URL(LAUNCH_ENDPOINT, page.url)).then(
						(response) => response.json() as Promise<{readonly url: string}>,
					),
				);
				assert.strictEqual(answered.url, app.server.launchUrl);

				// The founder's browser sends the page's origin, never the socket's. Every proof above
				// passes without this because a Node client sends no Origin at all (#7560).
				const pageOrigin = new URL(page.url).origin;
				assert.deepStrictEqual(
					[
						yield* upgradeStatus(answered.url, pageOrigin),
						yield* upgradeStatus(answered.url, `http://localhost:${page.port}`),
						yield* upgradeStatus(answered.url, `http://127.0.0.1:${app.server.port}`),
						yield* upgradeStatus(answered.url, undefined),
						yield* upgradeStatus(answered.url, "http://127.0.0.1:1"),
						yield* upgradeStatus(answered.url, "https://evil.example"),
					],
					[101, 101, 101, 101, 401, 401],
					"admitted: the page's own origin in every loopback spelling, the socket's, and a client sending none",
				);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);
});
