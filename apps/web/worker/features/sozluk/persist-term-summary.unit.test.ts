/**
 * Coverage for the `recomputeTermSummary` → row-write coupling (#1337) — the seam
 * the fold-only `recompute-term-summary.unit.test.ts` leaves untested. The pure
 * fold is proven in isolation there; what THIS file proves is that the fold's
 * output is wired into the `term_record` upsert (and its `term_search` FTS
 * dual-write) in the one convergent call-site every term write funnels through
 * (`persistTermSummary`, module-private).
 *
 * Driven THROUGH the public mutation (`editDefinition`) against a scripted
 * `Drizzle` double whose `batch` renders each statement's `.toSQL()` — the
 * `contributions-sandbox.unit.test.ts` / `VouchLedger.unit.test.ts` idiom (no
 * engine, ADR 0082/0104/0105: no revived `node:sqlite` fake, no `runFateOp`). The
 * batch is captured, not executed, so the row/column LANDING is unit-reachable;
 * row-level behavior on real D1 stays the integration tier's job.
 */
import {describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {type Context, Effect, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive, type TermSummaryDefRow} from "./Sozluk.ts";

// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed in a fake; only `.toSQL()` rendering is exercised — the scripted `run`/`batch` never execute a query.
const noopD1 = {
	prepare: () => ({
		bind() {
			return this;
		},
		async all() {
			return {results: []};
		},
		async first() {
			return null;
		},
		async run() {
			return {};
		},
		async raw() {
			return [];
		},
	}),
	async batch() {
		return [];
	},
} as unknown as D1Database;
const renderDb = drizzle(noopD1, {relations});

// editDefinition doesn't touch Vote (it's consulted on the vote/aggregate paths),
// so an inert instance satisfies the layer dependency without an implementation.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);

type Rendered = {sql: string; params: unknown[]};

// Replays `run` results in call order; captures every `batch` statement's `.toSQL()`.
// editDefinition's run order: (0) findFirst definition, (1) update body,
// (2) persistTermSummary's live-defs SELECT — then ONE batch (term_record upsert +
// the two `term_search` FTS statements).
function scriptedAccess(runResults: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	batched: Rendered[];
} {
	const state = {i: 0};
	const batched: Rendered[] = [];
	const access: DrizzleAccess = {
		run: <A>(_fn: (db: DrizzleDb) => Promise<A>) => Effect.succeed(runResults[state.i++] as A),
		batch: <T extends Readonly<[unknown, ...unknown[]]>>(fn: (db: DrizzleDb) => T) => {
			for (const stmt of fn(renderDb as never) as ReadonlyArray<unknown>) {
				// drizzle's `BatchItem`/`Stmt` carries `.toSQL()` at runtime but doesn't expose it on the type.
				batched.push((stmt as {toSQL: () => Rendered}).toSQL());
			}
			return Effect.succeed([] as never);
		},
	};
	return {access, batched};
}

const sozlukOver = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(Layer.succeed(Drizzle, access)),
		Layer.provide(inertVote),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
	);

const SLUG = "kelime";
const TITLE = "Kelime";
const OWNER = "u1";

// The definition `editDefinition` resolves first (its findFirst result) — author
// matches the actor so the mutation proceeds to the summary recompute.
const editedDefinition = {
	id: "def_1",
	authorId: OWNER,
	authorName: "umut",
	termSlug: SLUG,
	termTitle: TITLE,
	score: 0,
	createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

// The live-definition slice the summary fold reads (term-page order: score desc).
// Distinctive values so each landed column is unambiguous in the rendered params.
const def = (over: Partial<TermSummaryDefRow> & {id: string}): TermSummaryDefRow => ({
	body: "body",
	bodyExcerpt: "excerpt",
	score: 0,
	createdAt: new Date("2024-02-01T00:00:00.000Z"),
	updatedAt: new Date("2024-02-01T00:00:00.000Z"),
	...over,
});
const liveDefs: TermSummaryDefRow[] = [
	def({id: "top-def", score: 10, bodyExcerpt: "the winning excerpt"}),
	def({id: "runner-up", score: 7, bodyExcerpt: "runner"}),
];

// Run editDefinition through the scripted seam and hand back the captured batch.
const renderUpsert = () =>
	Effect.gen(function* () {
		const {access, batched} = scriptedAccess([editedDefinition, {}, liveDefs]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.editDefinition({definitionId: "def_1", actorId: OWNER, body: "a fresh body"});
		}).pipe(Effect.provide(sozlukOver(access)));
		return batched;
	});

describe("persistTermSummary — the recomputeTermSummary → term_record row-write coupling (#1337)", () => {
	it.effect(
		"the fold output lands in the term_record upsert, with the FTS dual-write alongside",
		() =>
			Effect.gen(function* () {
				const batched = yield* renderUpsert();

				// One batch: the summary upsert + the two `term_search` FTS statements,
				// all-or-none (ADR 0080 lockstep).
				assert.strictEqual(
					batched.length,
					3,
					"term_record upsert + the two term_search statements",
				);

				const upsert = batched[0];
				if (!upsert) throw new Error("no term_record statement was captured");
				assert.match(upsert.sql, /term_record/, "the first statement targets term_record");
				assert.isTrue(
					batched.slice(1).some((s) => /term_search/.test(s.sql)),
					"the FTS dual-write to term_search rides the same batch",
				);

				// recomputeTermSummary([top score 10, runner score 7], "kelime", "Kelime") ⇒
				// count 2, totalScore 17, top "top-def", excerpt "the winning excerpt",
				// firstLetter "k" — each must appear in the rendered upsert params.
				const p = upsert.params;
				assert.include(p, SLUG, "slug column");
				assert.include(p, TITLE, "title column");
				assert.include(p, "k", "first_letter is the lowercased slug head");
				assert.include(p, 2, "definition_count is the live-slice length");
				assert.include(p, 17, "total_score is the summed scores");
				assert.include(p, "the winning excerpt", "excerpt is the top definition's excerpt");
				assert.include(p, "top-def", "top_definition_id is rows[0]");
			}),
	);
});
