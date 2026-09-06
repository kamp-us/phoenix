/**
 * Opening a session to read it, and the three facts that make it read-only (epic #8070, ruling 2).
 *
 * The load-bearing one is the second test: the read runs under a real `Processes` / `ProcessTable`
 * / `Checkpoints`, and both the process table and the restore manifest are asserted untouched
 * afterwards. Nothing else in the tree stops a future edit from reaching for a spawn here, so the
 * assertion is the whole guard.
 *
 * The other two are the pair a blank transcript would hide. History comes back one page at a time
 * off the port's own `page(before, limit)`, and a session the store has since lost is a refusal
 * rather than an empty page — a row that opens onto silence has to mean the session is empty.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {ItemId, type TranscriptItem} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {models, modes, thinking} from "./service/fixtures/scripts.ts";
import {type AgentScript, ScriptedAiAgent} from "./service/index.ts";
import {readAiAgentTranscript} from "./transcripts.ts";

const at = (offset: number): number => 1_760_000_000_000 + offset;

const said = (id: string, text: string): TranscriptItem => ({
	kind: "user",
	id: ItemId.make(id),
	timestamp: at(0),
	text,
});

/** A backend row whose script holds one session with `history` behind it. */
const backendRow = (
	id: string,
	sessionId: string,
	history: ReadonlyArray<TranscriptItem>,
): AnyProgram => {
	const script: AgentScript = {
		sessionId,
		history,
		modes,
		models,
		thinking,
		turns: [],
		interrupt: [],
	};
	return aiAgentProgram({id, layer: ScriptedAiAgent.layer(script), config: {cwd: "/workspace"}});
};

const history = [said("m-1", "one"), said("m-2", "two"), said("m-3", "three")];

const rows = [backendRow("pi", "s-1", history)];

/** The real process machinery, so "nothing was spawned" is a claim about the thing that spawns. */
const kernel = (): Layer.Layer<Processes | ProcessTable | Registry | Checkpoints> =>
	Processes.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(Layer.orDie(Registry.layer(rows)), Checkpoints.layer(memoryStores())),
		),
	);

const read = (request: {
	readonly backend: string;
	readonly sessionId: string;
	readonly before?: string | null;
	readonly limit?: number;
}) =>
	Effect.flatMap(Effect.context<Registry>(), (services) =>
		readAiAgentTranscript(services, {
			backend: ProgramId.make(request.backend),
			sessionId: request.sessionId,
			cwd: "/workspace",
			before: request.before ?? null,
			limit: request.limit ?? 50,
		}),
	);

describe("reading a session's transcript", () => {
	it.effect("answers a page off the port's own paging rather than the whole transcript", () =>
		Effect.gen(function* () {
			const page = yield* read({backend: "pi", sessionId: "s-1", limit: 2});

			assert.deepStrictEqual(
				page.items.map((item) => item.id as string),
				["m-2", "m-3"],
			);
			assert.strictEqual(page.next, "m-2");

			const older = yield* read({backend: "pi", sessionId: "s-1", before: page.next, limit: 2});
			assert.deepStrictEqual(
				older.items.map((item) => item.id as string),
				["m-1"],
			);
			assert.strictEqual(older.next, null);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("starts no process and writes no restore state", () =>
		Effect.gen(function* () {
			const table = yield* ProcessTable;
			const checkpoints = yield* Checkpoints;
			assert.deepStrictEqual(yield* table.list, []);
			assert.deepStrictEqual(yield* checkpoints.list, []);

			const page = yield* read({backend: "pi", sessionId: "s-1"});
			assert.lengthOf(page.items, 3);

			assert.deepStrictEqual(yield* table.list, []);
			assert.deepStrictEqual(yield* checkpoints.list, []);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("refuses a session the store no longer holds instead of answering an empty page", () =>
		Effect.gen(function* () {
			const raised = yield* Effect.flip(read({backend: "pi", sessionId: "gone"}));

			assert.strictEqual(raised._tag, "tuval/ai-agent/StartError");
			assert.strictEqual(
				raised._tag === "tuval/ai-agent/StartError" ? raised.reason : null,
				"session-not-found",
			);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("names the registered backends when the request names one that is not one", () =>
		Effect.gen(function* () {
			const raised = yield* Effect.flip(read({backend: "claude", sessionId: "s-1"}));

			assert.strictEqual(raised._tag, "tuval/ai-agent/BackendUnknown");
			assert.include(raised.message, "pi");
		}).pipe(Effect.provide(kernel())),
	);
});
