/**
 * Coverage for the `recomputeTermSummary` → row-write coupling (#1337). The pure fold
 * is proven in `recompute-term-summary.unit.test.ts`; what this proves is that its
 * output reaches the `term_record` upsert and the `term_search` dual-write.
 *
 * The scripted `Drizzle` double renders each batched statement's `.toSQL()` rather
 * than executing it, so the row/column landing is unit-reachable with no engine (ADR
 * 0082/0104/0105); real-D1 behavior stays the integration tier's job.
 */
import {describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {type Context, Effect, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {DefinitionId, UserId} from "../../lib/ids.ts";
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

// `editDefinition` never touches Vote, so an inert instance satisfies the dependency.
const inertVote = Layer.succeed(Vote, {} as Context.Service.Shape<typeof Vote>);

type Rendered = {sql: string; params: unknown[]};

// Replays `run` results in call order, so the script depends on `editDefinition`'s
// order: findFirst definition, update body, then the live-defs SELECT.
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
const OWNER = UserId.make("u1");

// The author matches the actor, so the mutation proceeds to the summary recompute.
const editedDefinition = {
	id: "def_1",
	authorId: OWNER,
	authorName: "umut",
	termSlug: SLUG,
	termTitle: TITLE,
	score: 0,
	createdAt: new Date("2024-01-01T00:00:00.000Z"),
};

// Distinctive values, so each landed column is unambiguous in the rendered params.
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

const renderUpsert = () =>
	Effect.gen(function* () {
		const {access, batched} = scriptedAccess([editedDefinition, {}, liveDefs]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.editDefinition({
				definitionId: DefinitionId.make("def_1"),
				actorId: OWNER,
				body: "a fresh body",
			});
		}).pipe(Effect.provide(sozlukOver(access)));
		return batched;
	});

describe("persistTermSummary — the recomputeTermSummary → term_record row-write coupling (#1337)", () => {
	it.effect(
		"the fold output lands in the term_record upsert, with the FTS dual-write alongside",
		() =>
			Effect.gen(function* () {
				const batched = yield* renderUpsert();

				// One batch, so the upsert and the FTS writes land all-or-none (ADR 0080).
				assert.strictEqual(
					batched.length,
					3,
					"term_record upsert + the two term_search statements",
				);

				const upsert = batched[0];
				if (!upsert) return yield* Effect.die(new Error("no term_record statement was captured"));
				assert.match(upsert.sql, /term_record/, "the first statement targets term_record");
				assert.isTrue(
					batched.slice(1).some((s) => /term_search/.test(s.sql)),
					"the FTS dual-write to term_search rides the same batch",
				);

				// The fold over the two live defs yields count 2 and totalScore 17.
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
