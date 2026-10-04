/**
 * Opening a session to read it, and the three facts that make it read-only (epic #8070, ruling 2).
 *
 * The load-bearing one is the second test: the read runs under a real `Processes` / `ProcessTable`
 * / `Checkpoints`, and both the process table and the restore manifest are asserted untouched
 * afterwards. Nothing else in the tree stops a future edit from reaching for a spawn here, so the
 * assertion is the whole guard.
 *
 * The other two are the pair a blank transcript would hide. History comes back one page at a time
 * off the port's own paging, and a session the store has since lost is a refusal rather than an
 * empty page — a row that opens onto silence has to mean the session is empty.
 *
 * The load-bearing assertion on the *backend* side is the sealed row (#8233): its script refuses
 * every `start`, so a read that answers at all is a read that opened no backend session and stood
 * no transport up for one. Its own `start` is asserted refusing right after, so the pass is the
 * read staying away rather than the fixture having no teeth.
 *
 * **The fixture's program id and backend tag are deliberately different strings.** The row is
 * registered as `pi-session` and its sessions carry the tag `pi`, because an earlier fixture used
 * one string for both and the two are two different fields — so a read wired to the tag resolved
 * anyway and every real session answered `BackendUnknown` (epic #8070's tail review). The last test
 * below closes that hole from the other end: it takes the id off a listed row rather than writing
 * one down, so the listing and the read have to agree about which field routes.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessTable} from "../process/ProcessTable.ts";
import {type AnyProgram, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {listAiAgentSessions} from "./backends.ts";
import {ItemId, type TranscriptItem} from "./ports/index.ts";
import {aiAgentProgram} from "./program.ts";
import {models, modes, thinking} from "./service/fixtures/scripts.ts";
import {
	type AgentScript,
	ScriptedAiAgent,
	StartError,
	sessionSummary,
	TuvalAiAgent,
} from "./service/index.ts";
import {readAiAgentTranscript} from "./transcripts.ts";

const at = (offset: number): number => 1_760_000_000_000 + offset;

const said = (id: string, text: string): TranscriptItem => ({
	kind: "user",
	id: ItemId.make(id),
	timestamp: at(0),
	text,
});

/** One session's script, listed under `tag`, optionally refusing every open. */
const scriptOf = (
	tag: string,
	sessionId: string,
	items: ReadonlyArray<TranscriptItem>,
	startRefusal?: StartError,
): AgentScript => ({
	sessionId,
	history: items,
	modes,
	models,
	thinking,
	turns: [],
	interrupt: [],
	sessions: [sessionSummary({sessionId, lastModified: at(0), backend: tag})],
	...(startRefusal === undefined ? {} : {startRefusal}),
});

/**
 * A backend row over one script.
 *
 * `id` and the script's backend tag are separate strings because they are separate fields on the
 * row a listing answers: `id` is what a read has to name and the tag is what the meta line prints.
 */
const programOf = (id: string, script: AgentScript): AnyProgram =>
	aiAgentProgram({id, layer: ScriptedAiAgent.layer(script), config: {cwd: "/workspace"}});

const history = [said("m-1", "one"), said("m-2", "two"), said("m-3", "three")];

const PROGRAM_ID = "pi-session";
const SEALED_ID = "pi-sealed";
const BACKEND_TAG = "pi";

const sealed = new StartError({
	reason: "transport",
	cwd: "/workspace",
	detail: "this script refuses every open",
});

const sealedScript = scriptOf(BACKEND_TAG, "s-2", history, sealed);

const rows = [
	programOf(PROGRAM_ID, scriptOf(BACKEND_TAG, "s-1", history)),
	programOf(SEALED_ID, sealedScript),
];

/** The real process machinery, so "nothing was spawned" is a claim about the thing that spawns. */
const kernel = (): Layer.Layer<Processes | ProcessTable | Registry | Checkpoints> =>
	Processes.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(Layer.orDie(Registry.layer(rows)), Checkpoints.layer(memoryStores())),
		),
	);

const read = (request: {
	readonly programId: string;
	readonly sessionId: string;
	readonly before?: string | null;
	readonly limit?: number;
}) =>
	Effect.flatMap(Effect.context<Registry>(), (services) =>
		readAiAgentTranscript(services, {
			programId: ProgramId.make(request.programId),
			sessionId: request.sessionId,
			cwd: "/workspace",
			before: request.before ?? null,
			limit: request.limit ?? 50,
		}),
	);

describe("reading a session's transcript", () => {
	it.effect("answers a page off the port's own paging rather than the whole transcript", () =>
		Effect.gen(function* () {
			const page = yield* read({programId: PROGRAM_ID, sessionId: "s-1", limit: 2});

			assert.deepStrictEqual(
				page.items.map((item) => item.id as string),
				["m-2", "m-3"],
			);
			assert.strictEqual(page.next, "m-2");

			const older = yield* read({
				programId: PROGRAM_ID,
				sessionId: "s-1",
				before: page.next,
				limit: 2,
			});
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

			const page = yield* read({programId: PROGRAM_ID, sessionId: "s-1"});
			assert.lengthOf(page.items, 3);

			assert.deepStrictEqual(yield* table.list, []);
			assert.deepStrictEqual(yield* checkpoints.list, []);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("refuses a session the store no longer holds instead of answering an empty page", () =>
		Effect.gen(function* () {
			const raised = yield* Effect.flip(read({programId: PROGRAM_ID, sessionId: "gone"}));

			assert.strictEqual(raised._tag, "tuval/ai-agent/TranscriptError");
			assert.strictEqual(
				raised._tag === "tuval/ai-agent/TranscriptError" ? raised.reason : null,
				"session-not-found",
			);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("acquires no session: it answers on a backend that refuses every open", () =>
		Effect.gen(function* () {
			const page = yield* read({programId: SEALED_ID, sessionId: "s-2"});
			assert.lengthOf(page.items, 3);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("and that backend really does refuse, so the read above stayed away", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const built = yield* Layer.build(ScriptedAiAgent.layer(sealedScript));
				const agent = Context.get(built, TuvalAiAgent);

				assert.strictEqual(yield* Effect.flip(agent.start({cwd: "/workspace"})), sealed);
			}),
		),
	);

	it.effect("names the registered backends when the request names one that is not one", () =>
		Effect.gen(function* () {
			const raised = yield* Effect.flip(read({programId: "claude-session", sessionId: "s-1"}));

			assert.strictEqual(raised._tag, "tuval/ai-agent/BackendUnknown");
			assert.include(raised.message, PROGRAM_ID);
		}).pipe(Effect.provide(kernel())),
	);

	it.effect("reads a listed row back through the very id the listing put on it", () =>
		Effect.gen(function* () {
			const services = yield* Effect.context<Registry>();
			const [listed] = (yield* listAiAgentSessions(services)).sessions;
			assert.isDefined(listed);

			// The tag and the id are two different strings on one row, which is the whole point: a
			// read wired to the tag resolves nothing.
			assert.strictEqual(listed.backend, BACKEND_TAG);
			assert.strictEqual(listed.programId as string, PROGRAM_ID);

			const page = yield* read({programId: listed.programId, sessionId: listed.sessionId});
			assert.lengthOf(page.items, 3);

			const raised = yield* Effect.flip(
				read({programId: listed.backend, sessionId: listed.sessionId}),
			);
			assert.strictEqual(raised._tag, "tuval/ai-agent/BackendUnknown");
		}).pipe(Effect.provide(kernel())),
	);
});
