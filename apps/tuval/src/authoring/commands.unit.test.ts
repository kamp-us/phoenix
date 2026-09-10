import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {expect, expectTypeOf} from "vitest";
import {SpawnedProcesses} from "../commands/core/process.ts";
import {buildRegistry} from "../commands/registry.ts";
import {type AnySpell, ClientId, type Scope, WorkspaceId} from "../commands/spell.ts";
import {ProcessId} from "../process/process.ts";
import type {AnyProgram} from "../registry/program.ts";
import type {CommandEffect} from "./commands.ts";
import {defineProgram} from "./define-program.ts";
import {emit, type ProgramEffect, send} from "./effect.ts";
import {port} from "./port.ts";

const scope: Scope = {workspace: WorkspaceId.make("w"), client: ClientId.make("c")};

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
const call = (spell: AnySpell, args: unknown) =>
	Effect.flatMap(Schema.decodeUnknownEffect(spell.params)(args), (decoded) =>
		spell.execute(decoded, scope),
	);

const unreachable = (name: string) => () => Effect.die(`a command cannot reach ${name}`);

/** Only `send` is exercised, so the other four members answer by dying rather than by pretending. */
const capturingSends = (sent: Array<readonly [string, unknown]>) =>
	Layer.succeed(
		SpawnedProcesses,
		SpawnedProcesses.of({
			send: (_process, portName, payload) =>
				Effect.sync(() => {
					sent.push([portName, payload]);
					return {delivered: true, evicted: 0};
				}),
			spawn: unreachable("spawn") as never,
			ask: unreachable("ask") as never,
			answer: unreachable("answer") as never,
			read: unreachable("read") as never,
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

	it("refuses an `emit` in a commands cell where it is written (ADR 0372)", () => {
		defineProgram({
			id: "emitting",
			ports: {announced: port.out(Schema.Number)},
			init: () => ({}),
			update: {noop: (state: Record<string, never>) => [state, []]},
			commands: {
				announce: {
					args: Schema.Number,
					// @ts-expect-error `emit` is not a `CommandEffect`: a spell call runs under no process,
					// so there is no out-port for the payload to leave by.
					run: (n: number) => [emit("announced", n)],
				},
			},
		});
		// The declaration still compiles to a spell; the refusal is the checker's, not the compiler's.
		expectTypeOf<CommandEffect>().not.toEqualTypeOf<ProgramEffect>();
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
