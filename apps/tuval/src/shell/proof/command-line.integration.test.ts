import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, it} from "@effect/vitest";
import {Context, Effect, Queue, Schema, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {coreSpells, start} from "../../boot.ts";
import {buildSpellIndex} from "../../commands/parse/spell-index.ts";
import {defineSpell} from "../../commands/spell.ts";
import {SpellSet} from "../../commands/spell-set.ts";
import {counterProgram} from "../../demo/counter.ts";
import {counterNode} from "../../demo/index.ts";
import {CallId, WindowId, WorkspaceId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, Snapshot} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {readCommandLine} from "../commands/line.ts";
import {serveDesk} from "../host/serve.ts";
import {defaultPrefixTable} from "../keys/table.ts";
import {attach} from "../transport/client.ts";

const echo = defineSpell({
	path: ["echo"],
	describe: "Echo text",
	params: Schema.Struct({text: Schema.String}),
	result: Schema.String,
	execute: ({text}) => Effect.succeed(text),
	capabilities: [],
});

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

it.effect("a page receives the actual registry and committed replacements over its socket", () =>
	Effect.gen(function* () {
		const stateDir = yield* Effect.acquireRelease(
			io(() => mkdtemp(join(tmpdir(), "tuval-command-line-"))),
			(path) => Effect.orDie(io(() => rm(path, {recursive: true, force: true}))),
		);
		const program = {...counterProgram({everyMs: null}), spells: [echo]};
		const started = yield* start({
			programs: [program],
			graph: {nodes: [{id: counterNode, program: program.id, on: []}]},
			stateDir,
		});
		const server = yield* serveDesk({kernel: started.kernel, port: 0, table: defaultPrefixTable});
		const page = yield* attach(server.launchUrl).pipe(
			Effect.provide(Socket.layerWebSocketConstructorGlobal),
		);
		const seen = yield* Queue.unbounded<RegistryDescription>();
		yield* Effect.forkScoped(Stream.runForEach(page.spells, (rows) => Queue.offer(seen, rows)));
		const initial = yield* Queue.take(seen);
		assert.ok(initial.some((row) => row.path.join(".") === "counter.echo"));
		const snapshot = new Snapshot({
			type: "snapshot",
			version: PROTOCOL_VERSION,
			rev: 0,
			desk: {workspaces: {}, activeWorkspace: WorkspaceId.make("")},
			windows: {},
			processes: [],
			registry: initial,
		});
		const route = (line: string) =>
			readCommandLine(line, {
				registry: buildSpellIndex(initial),
				snapshot,
				id: CallId.make(crypto.randomUUID()),
			});
		const call = route('counter echo "ordinary program"');
		assert.strictEqual(call._tag, "Spell");
		if (call._tag !== "Spell") return yield* Effect.die("command did not route");
		const reply = yield* page.call(call.call);
		assert.strictEqual(reply.ok, true);
		if (!reply.ok) return yield* Effect.die("program call was refused");
		assert.strictEqual(reply.result, "ordinary program");
		const badWindow = yield* page.call({
			...call.call,
			id: CallId.make("bad-window"),
			window: WindowId.make("missing"),
		});
		assert.strictEqual(badWindow.ok, false);
		if (badWindow.ok) return yield* Effect.die("unknown window was accepted");
		assert.strictEqual(badWindow.error.tag, "tuval/commands/NoSuchWindow");
		for (const line of [
			"help counter echo",
			'help "counter echo"',
			"help counter.echo",
			"spell describe counter echo",
			'spell describe "counter echo"',
			"spell describe counter.echo",
		]) {
			const help = route(line);
			assert.strictEqual(help._tag, "Spell");
			if (help._tag !== "Spell") return yield* Effect.die("discovery did not route");
			const described = yield* page.call(help.call);
			assert.strictEqual(described.ok, true);
			if (!described.ok) return yield* Effect.die("discovery was refused");
			assert.deepStrictEqual(
				described.result,
				line.startsWith("help")
					? [{path: "counter echo", usage: "<text>", describe: "Echo text"}]
					: initial.find((row) => row.path.join(".") === "counter.echo"),
			);
		}
		const set = Context.get(started.kernel, SpellSet);
		const rejected = yield* set
			.reload({core: [...coreSpells, echo, echo], programs: [], keys: []})
			.pipe(Effect.result);
		assert.strictEqual(rejected._tag, "Failure");
		yield* set.reload({core: coreSpells, programs: [], keys: []});
		const next = yield* Queue.take(seen);
		assert.ok(!next.some((row) => row.path.join(".") === "counter.echo"));
		assert.ok(next.some((row) => row.path.join(".") === "help"));
	}).pipe(Effect.scoped),
);
