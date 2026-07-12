/**
 * The `Divan` read-model service (#1287) over stub Sözlük/Pano (ADR 0082 unit tier,
 * no DB). The stubs re-express the `listSandboxed*` contract — they return ONLY
 * sandboxed, not-removed rows, optionally scoped to one author — so the test proves
 * the divan, composing them, yields a person-grouped roster that excludes removed and
 * live content, and that `backlogOf` scopes to one çaylak newest-first.
 *
 * Removed-exclusion is the `sandboxBacklogWhere` predicate's job in the REAL reads
 * (it carries `removed_at IS NULL`); here the stub honors that contract and the test
 * asserts the divan faithfully reflects it. Each stub is the `definition-mutation`
 * `Proxy`-over-`Partial` idiom: scripted reads, every other method dies on contact.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {UserId} from "../../lib/ids.ts";
import {type CommentRow, Pano, type PostSummaryRow} from "../pano/Pano.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {ProfileIdentityRow} from "../pasaport/Pasaport.ts";
import type {DefinitionRow} from "../sozluk/definition-fields.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {Divan, DivanLive} from "./Divan.ts";

interface Raw {
	readonly id: string;
	readonly authorId: string;
	readonly sandboxed: boolean;
	readonly removed: boolean;
	readonly createdAt: Date;
	readonly text: string;
}

const at = (iso: string) => new Date(iso);

// The `sandboxBacklogWhere` contract the real `listSandboxed*` reads enforce:
// still-sandboxed, not-removed, optionally one author's backlog.
const backlog = (rows: ReadonlyArray<Raw>, opts: {authorId?: string} = {}) =>
	rows.filter(
		(r) =>
			r.sandboxed && !r.removed && (opts.authorId === undefined || r.authorId === opts.authorId),
	);

const asDefinition = (r: Raw): DefinitionRow => ({
	id: r.id,
	body: r.text,
	score: 0,
	author: "anon",
	authorId: r.authorId,
	createdAt: r.createdAt,
	updatedAt: r.createdAt,
});

const asPost = (r: Raw): PostSummaryRow => ({
	id: r.id,
	slug: r.id,
	title: r.text,
	url: null,
	host: null,
	body: null,
	author: "anon",
	authorId: r.authorId,
	score: 0,
	commentCount: 0,
	createdAt: r.createdAt,
	tags: [],
});

const asComment = (r: Raw): CommentRow => ({
	id: r.id,
	parentId: null,
	author: "anon",
	authorId: r.authorId,
	body: r.text,
	score: 0,
	createdAt: r.createdAt,
	updatedAt: r.createdAt,
	deletedAt: null,
});

const die = (label: string) => () => Effect.die(new Error(`${label} not exercised in Divan test`));

const sozlukStub = (defs: ReadonlyArray<Raw>): Layer.Layer<Sozluk> =>
	Layer.succeed(
		Sozluk,
		new Proxy(
			{
				listSandboxedDefinitions: (opts: {authorId?: string} = {}) =>
					Effect.succeed(backlog(defs, opts).map(asDefinition)),
			} as Partial<typeof Sozluk.Service>,
			{
				get(target, prop) {
					if (prop in target) return (target as Record<string, unknown>)[prop as string];
					return die(`Sozluk.${String(prop)}`);
				},
			},
		) as typeof Sozluk.Service,
	);

const panoStub = (posts: ReadonlyArray<Raw>, comments: ReadonlyArray<Raw>): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy(
			{
				listSandboxedPosts: (opts: {authorId?: string} = {}) =>
					Effect.succeed(backlog(posts, opts).map(asPost)),
				listSandboxedComments: (opts: {authorId?: string} = {}) =>
					Effect.succeed(backlog(comments, opts).map(asComment)),
			} as Partial<typeof Pano.Service>,
			{
				get(target, prop) {
					if (prop in target) return (target as Record<string, unknown>)[prop as string];
					return die(`Pano.${String(prop)}`);
				},
			},
		) as typeof Pano.Service,
	);

// The batched identity read the roster joins on: returns only the requested ids that
// have a profile row, so an author absent here degrades to null handle + 0 karma.
const pasaportStub = (identities: ReadonlyArray<ProfileIdentityRow>) =>
	makePasaportStub({
		getProfileIdentitiesByIds: (ids) =>
			Effect.succeed(identities.filter((i) => ids.includes(i.userId))),
	});

// cyl-a has a full profile; cyl-b is deliberately ABSENT so the roster join exercises
// the missing-profile degradation (null handle + 0 karma → the "çaylak" label client-side).
const IDENTITIES: ReadonlyArray<ProfileIdentityRow> = [
	{userId: "cyl-a", username: "ada", displayName: "Ada Lovelace", totalKarma: 7},
];

const DEFS: ReadonlyArray<Raw> = [
	{
		id: "d1",
		authorId: "cyl-a",
		sandboxed: true,
		removed: false,
		createdAt: at("2026-06-25T01:00:00Z"),
		text: "tanım 1",
	},
	{
		id: "d2",
		authorId: "cyl-a",
		sandboxed: true,
		removed: true,
		createdAt: at("2026-06-25T02:00:00Z"),
		text: "kaldırılmış",
	},
	{
		id: "d3",
		authorId: "cyl-b",
		sandboxed: true,
		removed: false,
		createdAt: at("2026-06-25T03:00:00Z"),
		text: "tanım 3",
	},
	{
		id: "d4",
		authorId: "yzr",
		sandboxed: false,
		removed: false,
		createdAt: at("2026-06-25T04:00:00Z"),
		text: "canlı",
	},
];
const POSTS: ReadonlyArray<Raw> = [
	{
		id: "p1",
		authorId: "cyl-a",
		sandboxed: true,
		removed: false,
		createdAt: at("2026-06-25T05:00:00Z"),
		text: "gönderi",
	},
];
const COMMENTS: ReadonlyArray<Raw> = [
	{
		id: "c1",
		authorId: "cyl-b",
		sandboxed: true,
		removed: false,
		createdAt: at("2026-06-25T06:00:00Z"),
		text: "yorum",
	},
	{
		id: "c2",
		authorId: "cyl-b",
		sandboxed: true,
		removed: true,
		createdAt: at("2026-06-25T07:00:00Z"),
		text: "kaldırılmış yorum",
	},
];

const layer = DivanLive.pipe(
	Layer.provideMerge(
		Layer.mergeAll(sozlukStub(DEFS), panoStub(POSTS, COMMENTS), pasaportStub(IDENTITIES)),
	),
);

const run = <A>(eff: Effect.Effect<A, never, Divan>): A =>
	Effect.runSync(eff.pipe(Effect.provide(layer)));

describe("Divan.roster — person-grouped, removed & live excluded", () => {
	it("groups by author with per-kind counts + inline identity; removed and live rows are excluded", () => {
		const roster = run(Effect.flatMap(Divan, (d) => d.roster()));
		assert.deepStrictEqual(roster, [
			{
				authorId: UserId.make("cyl-a"),
				username: "ada",
				displayName: "Ada Lovelace",
				totalKarma: 7,
				definitionCount: 1,
				postCount: 1,
				commentCount: 0,
				totalCount: 2,
			},
			// cyl-b has no profile row → the join degrades to null handle + 0 karma.
			{
				authorId: UserId.make("cyl-b"),
				username: null,
				displayName: null,
				totalKarma: 0,
				definitionCount: 1,
				postCount: 0,
				commentCount: 1,
				totalCount: 2,
			},
		]);
	});
});

describe("Divan preview — a short excerpt, never the full node", () => {
	const longBody = "söz ".repeat(200).trim(); // ~799 chars, well past the 280 excerpt cap
	const longLayer = DivanLive.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				sozlukStub([
					{
						id: "d-long",
						authorId: "cyl-a",
						sandboxed: true,
						removed: false,
						createdAt: at("2026-06-25T01:00:00Z"),
						text: longBody,
					},
				]),
				panoStub([], []),
				pasaportStub(IDENTITIES),
			),
		),
	);

	it("truncates a long body to the ellipsis excerpt form", () => {
		const items = Effect.runSync(
			Effect.flatMap(Divan, (d) => d.backlogOf(UserId.make("cyl-a"))).pipe(
				Effect.provide(longLayer),
			),
		);
		const item = items[0];
		if (item === undefined) throw new Error("expected one backlog item");
		assert.isBelow(item.preview.length, longBody.length);
		assert.isTrue(item.preview.endsWith("…"));
		assert.strictEqual(item.preview.length, 280);
	});
});

describe("Divan.backlogOf — one çaylak's sandboxed backlog, newest first", () => {
	it("returns only that author's sandboxed-not-removed items, newest first", () => {
		const items = run(Effect.flatMap(Divan, (d) => d.backlogOf(UserId.make("cyl-a"))));
		assert.deepStrictEqual(
			items.map((i) => ({kind: i.kind, id: i.id})),
			[
				{kind: "post", id: "p1"},
				{kind: "definition", id: "d1"},
			],
		);
	});

	it("excludes a removed item from the scoped backlog", () => {
		const items = run(Effect.flatMap(Divan, (d) => d.backlogOf(UserId.make("cyl-b"))));
		// cyl-b has c1 (06:00, sandboxed), c2 (07:00, REMOVED), d3 (03:00, sandboxed):
		// the removed c2 is absent; the rest newest-first.
		assert.deepStrictEqual(
			items.map((i) => i.id),
			["c1", "d3"],
		);
	});
});

describe("Divan.pendingCountOf — the mod-notification 0→1 transition gate (#1699)", () => {
	it("counts a çaylak's still-pending items across all kinds (removed & live excluded)", () => {
		// cyl-a: d1 (sandboxed) + p1 (sandboxed) = 2; d2 (removed) and the yazar's live d4 excluded.
		assert.strictEqual(run(Effect.flatMap(Divan, (d) => d.pendingCountOf("cyl-a"))), 2);
	});

	it("is 0 for an author with no pending items", () => {
		assert.strictEqual(run(Effect.flatMap(Divan, (d) => d.pendingCountOf("yzr"))), 0);
	});
});
