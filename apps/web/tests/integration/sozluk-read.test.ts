/**
 * sozluk reads — system smoke against the deployed worker `/fate` route (ADR 0026–0031).
 *
 * This is the SMOKE residue after the keyset/pagination CORRECTNESS was migrated
 * down to a T2 fate-op test (`worker/features/fate/sozluk-keyset.test.ts`):
 * popular/recent ordering across pages, the `Term.definitions` keyset walk, the
 * `endCursor`/`hasNext` semantics, and stale-cursor collapse are all asserted at
 * T2 now, seeded by direct INSERT with explicit `score`/`createdAt`/`id` — no
 * votes, no `sleep`. The flake engine that lived here (HTTP sign-up + per-score
 * `definition.vote` seeding + a `sleep(1100)` to space `last_activity_at` across
 * its second-resolution) is gone with it.
 *
 * What stays here is the genuinely system-level claim T2 cannot make: the
 * DEPLOYED worker serves sozluk reads end-to-end over HTTP — the `/fate` route is
 * wired, a `terms` list + a `term` detail + the nested `Term.definitions`
 * connection resolve over the wire, and the session-derived Definition scalar
 * surface (author/authorId/myVote) round-trips. One small seed, single page, no
 * ordering walk.
 *
 * D1 is shared across all test files (one deploy), so the slug is uniquely
 * prefixed (`szread-${Date.now()}-…`) — never reuse a slug another test may touch.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {harness} from "./_harness.ts";

const h = harness();

const STAMP = Date.now();
const SLUG = `szread-${STAMP}-detail`;

interface TermNode {
	slug: string;
	title: string;
	count: number;
	totalScore: number;
}
interface DefNode {
	id: string;
	body: string;
	score: number;
	author: string;
	authorId: string;
	myVote: number | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

// One seeded term with two definitions — enough to prove the read surface serves
// over HTTP without realizing a deterministic keyset (that is the T2 fixture's
// job). The real `authorId` the worker assigned is captured from the seed.
let seeded: Awaited<ReturnType<typeof h.seedTerm>>["definitions"];

beforeAll(async () => {
	const result = await h.seedTerm({
		slug: SLUG,
		title: "Fate Read",
		definitions: [
			{authorName: "umut", body: "alpha definition", score: 2},
			{authorName: "elif", body: "beta definition", score: 1},
		],
	});
	seeded = result.definitions;
});

describe("sozluk reads — deployed worker /fate (system smoke)", () => {
	it("terms(recent) serves the seeded row with its slug cursor", async () => {
		const result = await h.fate({
			kind: "list",
			name: "terms",
			args: {sort: "recent", first: 100},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as Connection<TermNode>;
		const row = data.items.find((e) => e.node.slug === SLUG);
		expect(row).toBeDefined();
		expect(row!.cursor).toBe(SLUG); // cursor is the slug keyset
		expect(row!.node.title).toBe("Fate Read");
		expect(row!.node.count).toBe(2);
		expect(data.pagination.hasPrevious).toBe(false);
	});

	it("term(slug) serves the detail row", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG},
			select: ["slug", "title", "count", "totalScore"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as TermNode;
		expect(data.slug).toBe(SLUG);
		expect(data.title).toBe("Fate Read");
		expect(data.count).toBe(2);
		expect(data.totalScore).toBe(3);
	});

	it("term(slug) serves null for an unknown slug", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: `szread-${STAMP}-does-not-exist`},
			select: ["slug"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Term.definitions resolves over HTTP with the session-derived scalar surface", async () => {
		const result = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: SLUG, definitions: {first: 10}},
			select: [
				"definitions.id",
				"definitions.body",
				"definitions.author",
				"definitions.authorId",
				"definitions.score",
				"definitions.myVote",
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const conn = (result.data as {definitions: Connection<DefNode>}).definitions;
		expect(conn.items.length).toBe(2);
		// Highest-scoring definition is alpha (umut, score 2), the first seeded row.
		// Identity is session-derived → assert the author name + the real id the
		// worker assigned (captured from the seed), not a caller-chosen id.
		const top = conn.items[0]!.node;
		expect(top.author).toBe("umut");
		expect(top.authorId).toBe(seeded[0]!.authorId);
		expect(top.score).toBe(2);
		// Anonymous viewer → myVote null.
		expect(top.myVote).toBeNull();
	});
});
