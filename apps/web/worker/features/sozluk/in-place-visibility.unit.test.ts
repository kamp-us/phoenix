/**
 * The sözlük read paths under the #6423 third viewer class (#6424, epic #4306) — proven
 * on the SQL each read actually emits, per viewer shape.
 *
 * Two claims, both containment claims:
 *   - an opted-in in-place viewer's mask is author-blind (`sandboxed_at IS NOT NULL`, no
 *     `author_id = ?` arm), and a connection's `totalCount` carries the SAME mask as its
 *     page — so a count can never disagree with the rows beside it;
 *   - every other viewer shape emits byte-for-byte the statement it emitted before the
 *     class existed. The goldens below ARE that pre-#6423 output, so the flag-off world
 *     (where nothing resolves `seesSandboxedInPlace: true`) is pinned by literal rather
 *     than by inspection.
 *
 * The goldens keep the whole statement — predicate, `order by`, `limit`, bound params —
 * with only the leading select-column list collapsed to `…`: that list is the schema's
 * axis, not the mask's, so an unrelated new column would otherwise red every row here
 * while proving nothing.
 *
 * Unit-tier per ADR 0082: row-level filtering is integration's job; this proves the
 * predicate each read wires in. The compiled SQL is captured off a substituted `Drizzle`
 * seam (the `term-list-sandbox` / `Sozluk.connection` scripted-access idiom) — a builder
 * handed back un-awaited renders via `.toSQL()`, while a read finalized inside the
 * callback (`.get().then(…)`) is recoverable only at the D1 binding's `prepare`.
 */
import {assert, describe, it} from "@effect/vitest";
import {drizzle} from "drizzle-orm/d1";
import {Effect, Layer} from "effect";
import {Drizzle, type DrizzleAccess, type DrizzleDb, relations} from "../../db/Drizzle.ts";
import {anonymousViewer, type SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import {PasaportIdentityStub} from "../pasaport/Pasaport.testing.ts";
import {ReactionStub} from "../reaction/Reaction.testing.ts";
import {Vote} from "../vote/Vote.ts";
import {Sozluk, SozlukLive} from "./Sozluk.ts";

const MEMBER = "u-yazar";
const MOD = "u-mod";

const member: SandboxViewer = {
	viewerId: MEMBER,
	canSeeSandboxed: false,
	seesSandboxedInPlace: false,
};
const inPlace: SandboxViewer = {
	viewerId: MEMBER,
	canSeeSandboxed: false,
	seesSandboxedInPlace: true,
};
const moderator: SandboxViewer = {
	viewerId: MOD,
	canSeeSandboxed: true,
	seesSandboxedInPlace: false,
};

interface Rendered {
	readonly sql: string;
	readonly params: unknown[];
}

/** A connection's two reads: the `totalCount` and the page. */
interface TwoReads {
	readonly count: Rendered;
	readonly page: Rendered;
}

// The schema's column list is not this test's axis; anchoring at `^` keeps an inner
// `select 1 from "definition_record"` (the term-list EXISTS) intact.
const collapse = ({sql, params}: Rendered): Rendered => ({
	sql: sql.replace(/^select "[\s\S]*?" from /, "select … from "),
	params,
});

const hasToSQL = (v: unknown): v is {toSQL: () => Rendered} =>
	typeof v === "object" && v !== null && typeof (v as {toSQL?: unknown}).toSQL === "function";

function scriptedAccess(results: ReadonlyArray<unknown>): {
	access: DrizzleAccess;
	builders: Rendered[];
	prepared: {sql: string; params: unknown[]}[];
} {
	const state = {i: 0};
	const builders: Rendered[] = [];
	const prepared: {sql: string; params: unknown[]}[] = [];
	// biome-ignore lint/plugin: `D1Database` is a host binding that can't be structurally constructed; only `prepare`/`batch` are exercised and every result is scripted.
	const capturingD1 = {
		prepare: (sql: string) => {
			const entry = {sql, params: [] as unknown[]};
			prepared.push(entry);
			return {
				bind(...params: unknown[]) {
					entry.params = params;
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
			};
		},
		async batch() {
			return [];
		},
	} as unknown as D1Database;
	const renderDb = drizzle(capturingD1, {relations});

	const access: DrizzleAccess = {
		run: <A>(fn: (db: DrizzleDb) => Promise<A>) => {
			const built = fn(renderDb) as unknown;
			if (hasToSQL(built)) builders.push(built.toSQL());
			return Effect.succeed(results[state.i++] as A);
		},
		batch: () => Effect.die(new Error("these reads must not batch")),
	};
	return {access, builders, prepared};
}

// biome-ignore lint/plugin: a service double — these reads only reach `readMine`.
const VoteStub = Layer.succeed(Vote, {
	cast: () => Effect.die(new Error("a read must not cast a vote")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service);

const sozlukLayer = (access: DrizzleAccess) =>
	SozlukLive.pipe(
		Layer.provide(VoteStub),
		Layer.provide(ReactionStub),
		Layer.provide(PasaportIdentityStub),
		Layer.provide(Layer.succeed(Drizzle, access)),
	);

const termMetaRow = {
	slug: "yazilim",
	title: "yazılım",
	totalDefinitions: 0,
	totalScore: 0,
	firstAt: new Date(0),
	lastActivityAt: new Date(0),
	lastEditAt: new Date(0),
};

/** `Sozluk.getTerm`'s definition read — the term page's definition list. */
const termPageSql = (viewer: SandboxViewer): Effect.Effect<Rendered> =>
	Effect.gen(function* () {
		const {access, builders} = scriptedAccess([termMetaRow, []]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.getTerm("yazilim", {sandboxViewer: viewer});
		}).pipe(Effect.provide(sozlukLayer(access)));
		// [0] is the `term_record` meta lookup (unmasked by design — the summary cache
		// carries no lifecycle columns); [1] is the masked definition read.
		const defs = builders[1];
		assert.isDefined(defs, "the definition read rendered off the seam");
		return collapse(defs);
	});

/** `Sozluk.listDefinitionsKeyset`'s two reads — the masked count and the masked page. */
const definitionsKeysetSql = (viewer: SandboxViewer): Effect.Effect<TwoReads> =>
	Effect.gen(function* () {
		const {access, builders, prepared} = scriptedAccess([0, []]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.listDefinitionsKeyset("yazilim", {sandboxViewer: viewer});
		}).pipe(Effect.provide(sozlukLayer(access)));
		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {count: collapse(count), page: collapse(page)};
	});

/** `Sozluk.getDefinitionsByIds` — the `Definition` source's batch loader. */
const definitionsByIdsSql = (viewer: SandboxViewer): Effect.Effect<Rendered> =>
	Effect.gen(function* () {
		const {access, builders} = scriptedAccess([[]]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.getDefinitionsByIds(["def_1"], {sandboxViewer: viewer});
		}).pipe(Effect.provide(sozlukLayer(access)));
		const fetch = builders[0];
		assert.isDefined(fetch, "the by-ids read rendered off the seam");
		return collapse(fetch);
	});

/** `Sozluk.listTermSummariesConnection`'s two reads — both gated on the derived probe. */
const termListSql = (viewer: SandboxViewer): Effect.Effect<TwoReads> =>
	Effect.gen(function* () {
		const {access, builders, prepared} = scriptedAccess([0, []]);
		yield* Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			yield* sozluk.listTermSummariesConnection({sort: "recent", sandboxViewer: viewer});
		}).pipe(Effect.provide(sozlukLayer(access)));
		const count = prepared[0];
		const page = builders[0];
		assert.isDefined(count, "the totalCount read reached the D1 binding");
		assert.isDefined(page, "the page read rendered off the seam");
		return {count: collapse(count), page: collapse(page)};
	});

const AUTHOR_ARM = /"definition_record"\."author_id" = \?/;
const SANDBOX_WIDENED = /"definition_record"\."sandboxed_at" is not null/i;

describe("sözlük reads — the opted-in in-place viewer's mask is author-blind (#6424)", () => {
	it.effect("the term page's definition read widens to every sandboxed definition", () =>
		Effect.gen(function* () {
			const {sql, params} = yield* termPageSql(inPlace);
			assert.match(sql, SANDBOX_WIDENED, "the sandboxed arm is admitted");
			assert.notMatch(sql, AUTHOR_ARM, "author-blind — no ownership arm");
			assert.notInclude(params, MEMBER, "the viewer id is never bound into the mask");
		}),
	);

	it.effect("the keyset page widens, and totalCount carries the IDENTICAL mask", () =>
		Effect.gen(function* () {
			const {count, page} = yield* definitionsKeysetSql(inPlace);
			for (const rendered of [count, page]) {
				assert.match(rendered.sql, SANDBOX_WIDENED, "the sandboxed arm is admitted");
				assert.notMatch(rendered.sql, AUTHOR_ARM, "author-blind — no ownership arm");
			}
			assert.notInclude(count.params, MEMBER);
			assert.notInclude(page.params, MEMBER);
		}),
	);

	it.effect("the `Definition` source's batch loader widens the same way", () =>
		Effect.gen(function* () {
			const {sql, params} = yield* definitionsByIdsSql(inPlace);
			assert.match(sql, SANDBOX_WIDENED);
			assert.notMatch(sql, AUTHOR_ARM);
			assert.notInclude(params, MEMBER);
		}),
	);

	// The term lists select from `term_record`, which has no lifecycle columns; visibility
	// is derived through `termHasVisibleDefinitionWhere`'s correlated EXISTS. It takes the
	// viewer and sources `publicLiveWhere`, so it honours the class with no second mask.
	it.effect("a sandbox-only term becomes reachable — the derived probe honours the class", () =>
		Effect.gen(function* () {
			const {count, page} = yield* termListSql(inPlace);
			for (const rendered of [count, page]) {
				assert.include(rendered.sql.toLowerCase(), 'exists (select 1 from "definition_record"');
				assert.match(rendered.sql, SANDBOX_WIDENED, "the EXISTS admits sandboxed definitions");
				assert.match(
					rendered.sql,
					/"definition_record"\."removed_at" is null/,
					"the removal guard is untouched",
				);
			}
		}),
	);

	it.effect("a sandbox-only term stays unreachable for an anonymous viewer", () =>
		Effect.gen(function* () {
			const {count, page} = yield* termListSql(anonymousViewer);
			for (const rendered of [count, page]) {
				assert.notMatch(rendered.sql, SANDBOX_WIDENED, "no sandboxed row is ever admitted");
				assert.match(rendered.sql, /"definition_record"\."sandboxed_at" is null/);
			}
		}),
	);
});

const TERM_PAGE_GOLDENS: Record<string, Rendered> = {
	anonymous: {
		sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null))) order by "definition_record"."score" desc, "definition_record"."created_at" asc',
		params: ["yazilim"],
	},
	"signed-in, not opted in": {
		sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?)))) order by "definition_record"."score" desc, "definition_record"."created_at" asc',
		params: ["yazilim", MEMBER],
	},
	moderator: {
		sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null))) order by "definition_record"."score" desc, "definition_record"."created_at" asc',
		params: ["yazilim"],
	},
};

const KEYSET_GOLDENS: Record<string, TwoReads> = {
	anonymous: {
		count: {
			sql: 'select count(*) from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null)))',
			params: ["yazilim"],
		},
		page: {
			sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null))) order by "definition_record"."score" desc, "definition_record"."created_at" asc, "definition_record"."id" asc limit ?',
			params: ["yazilim", 51],
		},
	},
	"signed-in, not opted in": {
		count: {
			sql: 'select count(*) from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?))))',
			params: ["yazilim", MEMBER],
		},
		page: {
			sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?)))) order by "definition_record"."score" desc, "definition_record"."created_at" asc, "definition_record"."id" asc limit ?',
			params: ["yazilim", MEMBER, 51],
		},
	},
	moderator: {
		count: {
			sql: 'select count(*) from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null)))',
			params: ["yazilim"],
		},
		page: {
			sql: 'select … from "definition_record" where (("definition_record"."term_slug" = ?) and (("definition_record"."removed_at" is null))) order by "definition_record"."score" desc, "definition_record"."created_at" asc, "definition_record"."id" asc limit ?',
			params: ["yazilim", 51],
		},
	},
};

const BY_IDS_GOLDENS: Record<string, Rendered> = {
	anonymous: {
		sql: 'select … from "definition_record" where (("definition_record"."id" in (?)) and (("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null)))',
		params: ["def_1"],
	},
	"signed-in, not opted in": {
		sql: 'select … from "definition_record" where (("definition_record"."id" in (?)) and (("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?))))',
		params: ["def_1", MEMBER],
	},
	moderator: {
		sql: 'select … from "definition_record" where (("definition_record"."id" in (?)) and (("definition_record"."removed_at" is null)))',
		params: ["def_1"],
	},
};

const TERM_LIST_GOLDENS: Record<string, TwoReads> = {
	anonymous: {
		count: {
			sql: 'select count(*) from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (((("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null))))))',
			params: [],
		},
		page: {
			sql: 'select … from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (((("definition_record"."removed_at" is null)) and (("definition_record"."sandboxed_at" is null)))))) order by "term_record"."last_activity_at" desc, "term_record"."slug" asc limit ?',
			params: [21],
		},
	},
	"signed-in, not opted in": {
		count: {
			sql: 'select count(*) from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (((("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?)))))))',
			params: [MEMBER],
		},
		page: {
			sql: 'select … from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (((("definition_record"."removed_at" is null)) and (((("definition_record"."sandboxed_at" is null)) or ("definition_record"."author_id" = ?))))))) order by "term_record"."last_activity_at" desc, "term_record"."slug" asc limit ?',
			params: [MEMBER, 21],
		},
	},
	moderator: {
		count: {
			sql: 'select count(*) from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (("definition_record"."removed_at" is null))))',
			params: [],
		},
		page: {
			sql: 'select … from "term_record" where exists (select 1 from "definition_record" where (("definition_record"."term_slug" = "term_record"."slug") and (("definition_record"."removed_at" is null)))) order by "term_record"."last_activity_at" desc, "term_record"."slug" asc limit ?',
			params: [21],
		},
	},
};

/**
 * With `phoenix-caylak-visibility` off nothing resolves `seesSandboxedInPlace: true`, so
 * every read below must emit exactly what it emitted before the class existed — drift
 * fails HERE rather than in production behind a dark flag.
 */
describe("sözlük reads — every non-in-place viewer emits byte-for-byte today's SQL (#6424)", () => {
	const shapes: ReadonlyArray<[name: string, viewer: SandboxViewer]> = [
		["anonymous", anonymousViewer],
		["signed-in, not opted in", member],
		["moderator", moderator],
	];

	for (const [name, viewer] of shapes) {
		it.effect(`${name} — the term page's definition read`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* termPageSql(viewer), TERM_PAGE_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the definition keyset's count and page`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* definitionsKeysetSql(viewer), KEYSET_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the \`Definition\` source's batch loader`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* definitionsByIdsSql(viewer), BY_IDS_GOLDENS[name]);
			}),
		);

		it.effect(`${name} — the term list's count and page`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* termListSql(viewer), TERM_LIST_GOLDENS[name]);
			}),
		);
	}
});
