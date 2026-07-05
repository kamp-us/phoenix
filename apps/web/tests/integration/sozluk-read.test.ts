/**
 * sozluk reads — system smoke against the deployed worker `/fate` route (ADR 0026–0031).
 *
 * This is the SMOKE residue after the keyset/pagination CORRECTNESS was migrated
 * down to a fate-op integration test (`worker/features/fate/sozluk-keyset.test.ts`):
 * popular/recent ordering across pages, the `Term.definitions` keyset walk, the
 * `endCursor`/`hasNext` semantics, and stale-cursor collapse are all asserted
 * there now, seeded by direct INSERT with explicit `score`/`createdAt`/`id` — no
 * votes, no `sleep`. The flake engine that lived here (HTTP sign-up + per-score
 * `definition.vote` seeding + a `sleep(1100)` to space `last_activity_at` across
 * its second-resolution) is gone with it.
 *
 * What stays here is the genuinely system-level claim that fate-op test cannot make: the
 * DEPLOYED worker serves sozluk reads end-to-end over HTTP — the `/fate` route is
 * wired, a `terms` list + a `term` detail + the nested `Term.definitions`
 * connection resolve over the wire, and the session-derived Definition scalar
 * surface (author/authorId/myVote) round-trips. One small seed, single page, no
 * ordering walk.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027): its one D1
 * is shared with every migrated file, so the seeded term's slug carries the deterministic
 * `NS` prefix (`${NS}-detail`) and the `terms` list read is scoped to that NS slug by
 * id-membership (find the row whose slug is this file's) — never an exact list/count,
 * which another file's terms would now break. The `term(slug)` detail + unknown-slug
 * reads are already keyed to the NS slug.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
const SLUG = `${NS}-detail`;

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
	myVote: boolean | null;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

// One seeded term with two definitions — enough to prove the read surface serves
// over HTTP without realizing a deterministic keyset (that is the keyset
// fixture's job). The real `authorId` the worker assigned is captured from the seed.
let seeded: Awaited<ReturnType<typeof h.seedTerm>>["definitions"];

beforeAll(async () => {
	const result = await h.seedTerm({
		slug: SLUG,
		title: "Fate Read",
		definitions: [
			{authorName: "anka", body: "alpha definition", score: 2},
			{authorName: "zumrud", body: "beta definition", score: 1},
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
			args: {slug: `${NS}-does-not-exist`},
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
		// Scope the scalar-surface assertion to the EXACT row this file seeded, found by
		// the real id the worker assigned (captured from the seed) — never the positional
		// `items[0]`. Determinism on the run-scoped SHARED stage (ADR 0104) rests on TWO
		// facts: the connection is `termSlug`-scoped so only this NS term's rows appear, AND
		// the seed's author identity is uniquified per run at the harness source, so the
		// stored `author_name` can't collide with a pre-existing stage actor. Asserting
		// against the seed's RETURNED `authorName` (never a base/handle literal) is what
		// closes the fixed-identity-on-a-shared-stage flake (#2116: `expected 'yazar' to
		// be 'umut'` — a fixed handle read back as another actor's).
		const alpha = conn.items.find((e) => e.node.id === seeded[0]!.id)?.node;
		expect(alpha).toBeDefined();
		// `author` round-trips the seed's own (uniquified) username (`author_name`, snapshotted
		// from `user.name` at add-time) — a straight scalar passthrough (`definition-fields.ts`:
		// `author: d => d.authorName`), NOT the `yazar` authorship-tier noun (ADR 0107).
		expect(alpha!.author).toBe(seeded[0]!.authorName);
		expect(alpha!.authorId).toBe(seeded[0]!.authorId);
		expect(alpha!.score).toBe(2);
		// Anonymous viewer → myVote null.
		expect(alpha!.myVote).toBeNull();
	});
});
