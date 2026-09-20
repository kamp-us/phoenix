import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option, Schema, Stream} from "effect";
import {expect, expectTypeOf} from "vitest";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {buildRegistry} from "../commands/registry.ts";
import {type AnySpell, ClientId, type Scope, WorkspaceId} from "../commands/spell.ts";
import {ProcessNotFound} from "../process/errors.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {ProcessId, type ProcessRow} from "../process/process.ts";
import {noSelfReport} from "../process/self-report.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import type {CommandEffect} from "./commands.ts";
import {defineProgram} from "./define-program.ts";
import {ask, emit, type ProgramEffect, reply, send, spawn, stop} from "./effect.ts";
import {port} from "./port.ts";

const scope: Scope = {workspace: WorkspaceId.make("w"), client: ClientId.make("c")};

/** The same scope with a calling process, which is the tie-breaker the ruling names. */
const calledFrom = (process: ProcessId): Scope => ({...scope, process});

/** One live row, with only the three fields the resolution reads filled honestly. */
const row = (id: string, program: string): ProcessRow => ({
	id: ProcessId.make(id),
	programId: ProgramId.make(program),
	parentId: Option.none(),
	ports: {},
	stateSummary: () => ({lifecycle: "running", revision: 0, state: null}),
	selfReport: () => noSelfReport,
});

/** The live set as a fixed list — the read `resolveOwnProcess` makes, and nothing else. */
const liveProcesses = (rows: ReadonlyArray<ProcessRow>) =>
	Layer.succeed(
		ProcessTable,
		ProcessTable.of({
			list: Effect.succeed(rows),
			get: (id) =>
				Option.match(Option.fromNullishOr(rows.find((held) => held.id === id)), {
					onNone: () => Effect.fail(new ProcessNotFound({id})),
					onSome: Effect.succeed,
				}),
			changes: Stream.empty,
		}),
	);

/**
 * The declaration the issue names, held apart from `defineProgram` so one test can compile it
 * under a second id and prove the group followed the id rather than anything in the declaration.
 */
const authored = {
	ports: {announced: port.out(Schema.Number)},
	init: () => ({seen: 0}),
	update: {noop: (state: {readonly seen: number}) => [state, []] as const},
	commands: {
		review: {
			args: Schema.Number,
			describe: "Open a review of the numbered pull request.",
			run: (pr: number) => send({process: ProcessId.make("p1"), port: "pr"}, pr),
		},
		"session.start": {
			args: Schema.Struct({name: Schema.String}),
			run: (args: {readonly name: string}) => [
				send({process: ProcessId.make("p1"), port: "sessions"}, args.name),
			],
		},
	},
} as const;

const reviewer = defineProgram({id: "pr-review", ...authored});

/** A second program declaring the same command name, to prove the two never meet. */
const shipper = defineProgram({
	id: "pr-ship",
	init: () => ({}),
	update: {noop: (state: Record<string, never>) => [state, []]},
	commands: {review: {args: Schema.Number, run: () => []}},
});

const spellNamed = (row: AnyProgram, path: string): AnySpell => {
	const found = (row.spells ?? []).find((spell) => spell.path.join(".") === path);
	if (found === undefined) throw new Error(`no spell "${path}" on row "${row.id}"`);
	return found;
};

/** Registration is read through the registry, since composing the group is the registry's job. */
const registeredPaths = (rows: ReadonlyArray<AnyProgram>) =>
	Effect.map(buildRegistry({core: [], programs: rows}), (table) =>
		table.rows.map((row) => row.path.join(".")),
	);

/** A call as the executor makes one: decode the raw args against `params`, then execute. */
const call = (spell: AnySpell, args: unknown, from: Scope = scope) =>
	Effect.flatMap(Schema.decodeUnknownEffect(spell.params)(args), (decoded) =>
		spell.execute(decoded, from),
	);

const unreachable = (name: string) => () => Effect.die(`a command cannot reach ${name}`);

/** `send` is the only member a command can reach at all, so the other five die rather than pretend. */
const capturingSends = (sent: Array<readonly [string, unknown]>) =>
	Layer.succeed(
		SpawnedProcesses,
		SpawnedProcesses.of({
			send: (_process, portName, payload) =>
				Effect.sync(() => {
					sent.push([portName, payload]);
					return {delivered: true, evicted: 0};
				}),
			spawn: unreachable("spawn"),
			adopt: unreachable("adopt"),
			ask: unreachable("ask"),
			answer: unreachable("answer"),
			read: unreachable("read"),
		}),
	);

/** The same capture, keeping the process each send was addressed to — which is what #8898 decides. */
const capturingTargets = (sent: Array<readonly [ProcessId, string, unknown]>) =>
	Layer.succeed(
		SpawnedProcesses,
		SpawnedProcesses.of({
			send: (process, portName, payload) =>
				Effect.sync(() => {
					sent.push([process, portName, payload]);
					return {delivered: true, evicted: 0};
				}),
			spawn: unreachable("spawn"),
			adopt: unreachable("adopt"),
			ask: unreachable("ask"),
			answer: unreachable("answer"),
			read: unreachable("read"),
		}),
	);

describe("authoring.commands", () => {
	it.effect("registers a declared command at [programId, ...declaredPath]", () =>
		Effect.map(registeredPaths([reviewer]), (paths) => {
			expect(spellNamed(reviewer, "review").path).toEqual(["review"]);
			expect(spellNamed(reviewer, "session.start").path).toEqual(["session", "start"]);
			expect(paths).toContain("pr-review.review");
			expect(paths).toContain("pr-review.session.start");
		}),
	);

	it.effect("takes the group from the row's own id, and the author writes no prefix", () => {
		const renamed = defineProgram({id: "pr-review-2", ...authored});
		return Effect.map(registeredPaths([renamed]), (paths) => {
			expect(paths).toEqual(["pr-review-2.review", "pr-review-2.session.start"]);
			// Nothing in the declaration itself names a group, so there is nothing to derive one from.
			expect(Object.keys(authored.commands)).toEqual(["review", "session.start"]);
			expect(renamed.identity?.package).toBe("@kampus/tuval");
			expect(paths.every((path) => !path.includes("kampus"))).toBe(true);
		});
	});

	it.effect("makes the declared args schema the spell's params", () => {
		expect(spellNamed(reviewer, "review").params).toBe(authored.commands.review.args);
		// The refusal is the executor's own decode of `params`, which is why nothing new refuses here.
		return Effect.map(Effect.exit(call(spellNamed(reviewer, "review"), "eight")), (exit) => {
			expect(exit._tag).toBe("Failure");
		});
	});

	it.effect("interprets run's effects as an update cell's effects are interpreted", () => {
		const sent: Array<readonly [string, unknown]> = [];
		return Effect.map(
			Effect.provide(call(spellNamed(reviewer, "session.start"), {name: "umut"}), [
				capturingSends(sent),
			]),
			() => {
				expect(sent).toEqual([["sessions", "umut"]]);
			},
		);
	});

	it("refuses every effect but `send` in a commands cell where it is written (ADR 0372)", () => {
		defineProgram({
			id: "over-reaching",
			ports: {announced: port.out(Schema.Number)},
			init: () => ({}),
			update: {noop: (state: Record<string, never>) => [state, []]},
			commands: {
				announce: {
					args: Schema.Number,
					// @ts-expect-error `emit` is not a `CommandEffect`: a spell call's `Scope` carries no
					// process of the declaring program's, so no out-port here is its to announce on.
					run: (n: number) => [emit("announced", n)],
				},
				start: {
					args: Schema.Number,
					// @ts-expect-error `spawn` is not a `CommandEffect`: its handler stamps the child's
					// parent off `ProcessSelf`, and a spell call runs under no process to be one (#8858).
					run: () => [spawn({programId: "reviewer", out: {}})],
				},
				enquire: {
					args: Schema.Number,
					// @ts-expect-error `ask` is not a `CommandEffect`: the answer is routed back to
					// `ProcessSelf`, and a spell call has no inbox for one to arrive in (#8858).
					run: (n: number) => [
						ask({process: ProcessId.make("p1"), port: "check"}, n, {reply: "r"}),
					],
				},
				answer: {
					args: Schema.Number,
					// @ts-expect-error `reply` is not a `CommandEffect`: it spends a correlation a
					// request-port arrival carried, and a spell call was asked nothing (#8858).
					run: () => [reply({correlation: "c"}, "done")],
				},
				halt: {
					args: Schema.Number,
					// @ts-expect-error `stop` is not a `CommandEffect`: a command may only `send`, and
					// ending a process is not a claim a spell call was handed (#8898).
					run: () => [stop(ProcessId.make("p1"))],
				},
			},
		});
		// The declarations still compile to spells; the refusal is the checker's, not the compiler's.
		expectTypeOf<CommandEffect>().not.toEqualTypeOf<ProgramEffect>();
		expectTypeOf<CommandEffect["type"]>().toEqualTypeOf<"send">();
	});

	describe("a bare port name resolves to a process of the declaring program (#8898)", () => {
		/** The declaration the ruling asks for: no process id anywhere in it. */
		const own = defineProgram({
			id: "pr-review",
			ports: {pr: port.in(Schema.Number)},
			init: () => ({}),
			update: {pr: (state: Record<string, never>) => [state, []]},
			commands: {review: {args: Schema.Number, run: (pr: number) => send("pr", pr)}},
		});
		const review = spellNamed(own, "review");

		it.effect("lands on the only live process of that program", () => {
			const sent: Array<readonly [string, unknown]> = [];
			return Effect.map(
				Effect.provide(call(review, 8898), [
					capturingSends(sent),
					liveProcesses([row("proc-a", "pr-review"), row("proc-x", "someone-else")]),
				]),
				() => {
					expect(sent).toEqual([["pr", 8898]]);
				},
			);
		});

		it.effect("lands on the caller's own process when several are live", () => {
			const sent: Array<readonly [ProcessId, string, unknown]> = [];
			const mine = ProcessId.make("proc-b");
			return Effect.map(
				Effect.provide(call(review, 8898, calledFrom(mine)), [
					capturingTargets(sent),
					liveProcesses([row("proc-a", "pr-review"), row("proc-b", "pr-review")]),
				]),
				() => {
					expect(sent).toEqual([[mine, "pr", 8898]]);
				},
			);
		});

		it.effect(
			"refuses, naming the program and the ambiguity, when several are live and the caller is none of them",
			() =>
				Effect.map(
					Effect.exit(
						Effect.provide(call(review, 8898), [
							capturingSends([]),
							liveProcesses([row("proc-a", "pr-review"), row("proc-b", "pr-review")]),
						]),
					),
					(exit) => {
						assert.isTrue(exit._tag === "Failure");
						const failure = exit._tag === "Failure" ? exit.cause.toString() : "";
						expect(failure).toContain("pr-review");
						expect(failure).toContain("proc-a");
						expect(failure).toContain("proc-b");
					},
				),
		);

		it.effect("refuses when no process of the program is live", () =>
			Effect.map(
				Effect.exit(
					Effect.provide(call(review, 8898), [
						capturingSends([]),
						liveProcesses([row("proc-x", "someone-else")]),
					]),
				),
				(exit) => {
					assert.isTrue(exit._tag === "Failure");
					expect(exit._tag === "Failure" ? exit.cause.toString() : "").toContain(
						'no live process of program "pr-review"',
					);
				},
			),
		);

		it.effect(
			"leaves the explicit `send({process, port}, …)` form reaching the process it names",
			() => {
				const sent: Array<readonly [ProcessId, string, unknown]> = [];
				const named = ProcessId.make("p1");
				return Effect.map(
					Effect.provide(call(spellNamed(reviewer, "session.start"), {name: "umut"}), [
						capturingTargets(sent),
						// Nothing of this program is live: an addressed send never reads the table.
						liveProcesses([]),
					]),
					() => {
						expect(sent).toEqual([[named, "sessions", "umut"]]);
					},
				);
			},
		);
	});

	it.effect("lets two programs declare one command name without colliding", () =>
		Effect.map(registeredPaths([reviewer, shipper]), (paths) => {
			expect(paths).toContain("pr-review.review");
			expect(paths).toContain("pr-ship.review");
		}),
	);

	it("leaves `spells` absent on a program declaring no commands", () => {
		const bare = defineProgram({
			id: "bare",
			init: () => ({}),
			update: {noop: (state: Record<string, never>) => [state, []]},
		});
		assert.isUndefined(bare.spells);
	});

	it("infers run's argument from the sibling args schema", () => {
		defineProgram({
			id: "typed",
			init: () => ({}),
			update: {noop: (state: Record<string, never>) => [state, []]},
			commands: {
				review: {
					args: Schema.Struct({pr: Schema.Number}),
					run: (args) => {
						expectTypeOf(args).toEqualTypeOf<{readonly pr: number}>();
						return [];
					},
				},
			},
		});
	});
});
