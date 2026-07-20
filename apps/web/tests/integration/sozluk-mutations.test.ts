/**
 * sozluk mutations — black-box against the deployed worker `/fate` route
 * (ADR 0026–0031).
 *
 * Ports the write surface of four pre-alchemy suites that drove the mutation
 * resolvers / `Sozluk` service directly inside workerd:
 *   - `fate-sozluk-mutations.test.ts` — add/vote/retract/edit/delete + wire-error
 *     parity (`BODY_REQUIRED`, `DEFINITION_NOT_FOUND`, `UNAUTHORIZED`).
 *   - `sozluk-add-definition.test.ts` — auto-create term, title-from-slug,
 *     validation (`BODY_REQUIRED`, `BODY_TOO_LONG`), second add extends the term.
 *   - `sozluk-edit-delete-definition.test.ts` — edit happy/validation/ownership,
 *     delete decrements aggregates, ownership, idempotent re-delete.
 *   - `sozluk-vote-definition.test.ts` — vote/idempotency/retract/round-trip/
 *     not-found.
 *
 * Everything is observed over HTTP. Author identity comes from the session
 * (`h.signUp`), not explicit `authorId`/`authorName` — so the add input is
 * `{termSlug, termTitle?, body}`. Direct D1 row assertions (body_excerpt,
 * deleted_at, vote-row counts, total_karma) are dropped; behavior is re-expressed
 * by re-resolving entities over `/fate`. Ownership uses two real users: the author
 * creates, the intruder's cookie attempts edit/delete → `UNAUTHORIZED`.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1 is
 * shared across every migrated file. Isolation is by `NS` (this file's deterministic
 * `nsToken`): every seeded identifier — sign-up emails, every term SLUG, every `seedTerm`
 * slug — is `${NS}-…`-prefixed, so this file's rows are uniquely its own on the shared D1.
 * Every assertion reads back by THIS file's own NS-prefixed term slug (a by-slug `term(slug)`
 * read is naturally scoped once the slug is NS-prefixed) or off a mutation's re-resolved
 * return — there is no global `terms`-LIST read here, so no assertion can observe another
 * file's rows. The `definitionCount`/`score`/`totalScore` receipts are read off this file's
 * own NS term/definition.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

interface DefNode {
	__typename: string;
	id: string;
	body: string;
	score: number;
	author: string;
	authorId: string;
	myVote: boolean | null;
}
interface TermNode {
	__typename: string;
	slug: string;
	title: string;
	count: number;
	totalScore: number;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let author: {userId: string; cookie: string};
let intruder: {userId: string; cookie: string};
let voter: {userId: string; cookie: string};

const DEF_SELECT = ["id", "body", "score", "author", "authorId", "myVote"];

beforeAll(async () => {
	author = await h.signUp(`${NS}-author@test.local`, "hunter2hunter2", "anka");
	intruder = await h.signUp(`${NS}-intruder@test.local`, "hunter2hunter2", "davetsiz");
	voter = await h.signUp(`${NS}-voter@test.local`, "hunter2hunter2", "oycu");
	// `voter` casts every real definition vote below — self-voting is blocked since #2216, so
	// the caster is never the definition's author. Since #1810's "earn to vote" gate a fresh
	// çaylak is rejected at cast, so promote both. `intruder` never votes, but it authors
	// the second definition an anonymous `term.count` must SEE — a çaylak's content is
	// sandbox-masked from every reader but the author/mod — so it is promoted too.
	await h.promoteToYazar(author.userId);
	await h.promoteToYazar(voter.userId);
	await h.promoteToYazar(intruder.userId);
});

describe("sozluk mutations — definition.add", () => {
	it("writes and returns the re-resolved Definition", async () => {
		const slug = `${NS}-add`;
		const result = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, termTitle: "Fate Mut Add", body: "an added definition"},
				select: DEF_SELECT,
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const def = result.data as DefNode;
		expect(def.__typename).toBe("Definition");
		expect(def.id).toBeTruthy();
		expect(def.body).toBe("an added definition");
		expect(def.author).toBe("anka");
		expect(def.authorId).toBe(author.userId);
		expect(def.score).toBe(0);
		expect(def.myVote).toBeNull();

		// The row really landed (a read-back through the term query sees it).
		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["slug", "definitions.id", "definitions.body"],
		});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		const conn = (term.data as {definitions: Connection<DefNode>}).definitions;
		expect(conn.items.some((e) => e.node.id === def.id)).toBe(true);
	});

	// The pure title-from-slug derivation is unit-tested off-DB in
	// worker/features/sozluk/definition-validation.unit.test.ts (ADR 0082) —
	// Sozluk.titleFromSlug. The "second add extends the term" case below keeps the
	// auto-create-term round-trip on real D1.

	it("a second add on the same slug extends the term, not creates a new one", async () => {
		const slug = `${NS}-two-defs`;
		await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "first definition body"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "second definition body"},
				select: ["id"],
			},
			{cookie: intruder.cookie},
		);

		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug},
			select: ["count"],
		});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		expect((term.data as TermNode).count).toBe(2);
	});

	// The pure definition-body codes (BODY_REQUIRED / BODY_TOO_LONG) on add are
	// unit-tested off-DB in worker/features/sozluk/definition-validation.unit.test.ts
	// (ADR 0082) — addDefinition calls validateBody before any DB read.

	it("anonymous writes surface UNAUTHORIZED", async () => {
		const result = await h.fate({
			kind: "mutation",
			name: "definition.add",
			input: {termSlug: `${NS}-anon`, body: "nope"},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("sozluk mutations — definition.vote / retractVote", () => {
	it("vote then retractVote return the entity with myVote stamped", async () => {
		const slug = `${NS}-vote`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "a votable definition"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const voted = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as DefNode).score).toBe(1);
		expect((voted.data as DefNode).myVote).toBe(true);

		const retracted = await h.fate(
			{
				kind: "mutation",
				name: "definition.retractVote",
				input: {id},
				select: ["score", "myVote"],
			},
			{cookie: voter.cookie},
		);
		expect(retracted.ok).toBe(true);
		if (!retracted.ok) return;
		expect((retracted.data as DefNode).score).toBe(0);
		expect((retracted.data as DefNode).myVote).toBe(false);
	});

	it("a vote leaves updatedAt untouched, but a genuine edit bumps it (#1634)", async () => {
		const slug = `${NS}-vote-updatedat`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "unedited body"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		// `created_at`/`updated_at` store at SECOND granularity (`integer(mode:"timestamp")`,
		// epoch seconds). If create + vote + edit all land in one wall-clock second, the edit's
		// `now` truncates to the SAME second as creation, so "the edit bumped updatedAt" sees no
		// change — a wall-clock-straddle flake in THIS test, not a product bug (production's
		// `editedAfter` uses a 60s grace, so second granularity is fine live). Make it
		// deterministic the same way the `recent`-keyset vertical constructs a timestamp it can't
		// race for: bypass the server write clock with a setup-only controlled D1 write
		// (`execD1`, the `setLastActivityAt` idiom, #643) to plant a known-OLD baseline, so the
		// edit's real `now` is unconditionally a LATER second regardless of execution speed.
		const BASELINE_EPOCH_S = 1_600_000_000; // 2020-09-13T12:26:40Z — a fixed whole second
		const backdated = await h.execD1(
			"UPDATE definition_record SET created_at = ?, updated_at = ? WHERE id = ?",
			[BASELINE_EPOCH_S, BASELINE_EPOCH_S, id],
		);
		expect(backdated).toBe(1);

		// Re-read updatedAt straight from D1 (a fresh `term` resolve), not off a
		// mutation return — the AC verifies the persisted row, not just the UI.
		const readUpdatedAt = async (): Promise<unknown> => {
			const term = await h.fate({
				kind: "query",
				name: "term",
				args: {slug, definitions: {first: 10}},
				select: ["definitions.id", "definitions.updatedAt"],
			});
			expect(term.ok).toBe(true);
			if (!term.ok) return undefined;
			const conn = (term.data as {definitions: Connection<{id: string; updatedAt: unknown}>})
				.definitions;
			return conn.items.find((e) => e.node.id === id)?.node.updatedAt;
		};

		const beforeVote = await readUpdatedAt();
		// The planted baseline really landed (a whole second in the past).
		expect(beforeVote).toBe(new Date(BASELINE_EPOCH_S * 1000).toISOString());

		const voted = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "updatedAt"]},
			{cookie: voter.cookie},
		);
		expect(voted.ok).toBe(true);
		if (!voted.ok) return;
		expect((voted.data as {score: number}).score).toBe(1);
		// Persisted updatedAt is unchanged by the vote (DB round-trip) — byte-identical to the
		// baseline — and the resolver/live-push return reports that same genuine value, not the
		// vote instant.
		expect(await readUpdatedAt()).toEqual(beforeVote);
		expect((voted.data as {updatedAt: unknown}).updatedAt).toEqual(beforeVote);

		// A genuine content edit still bumps updatedAt — edit detection is not disabled. Because
		// the baseline is a constructed PAST second, the edit's real `now` is deterministically a
		// later second, so this holds no matter how fast create+vote+edit ran (no second-straddle).
		const edited = await h.fate(
			{kind: "mutation", name: "definition.edit", input: {id, body: "edited body"}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		const afterEdit = await readUpdatedAt();
		expect(afterEdit).not.toEqual(beforeVote);
		// Not merely different — strictly forward: an edit advances updatedAt past the baseline.
		expect(new Date(afterEdit as string).getTime()).toBeGreaterThan(
			new Date(beforeVote as string).getTime(),
		);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const slug = `${NS}-vote-idem`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "idem"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const first = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as DefNode).score).toBe(1);

		const second = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as DefNode).score).toBe(1);
		expect((second.data as DefNode).myVote).toBe(true);
	});

	it("retracting a vote that doesn't exist is a no-op (score 0, myVote false)", async () => {
		const slug = `${NS}-vote-noop`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "noop"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const result = await h.fate(
			{
				kind: "mutation",
				name: "definition.retractVote",
				input: {id},
				select: ["score", "myVote"],
			},
			{cookie: voter.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.data as DefNode).score).toBe(0);
		expect((result.data as DefNode).myVote).toBe(false);
	});

	it("vote → retract → vote round-trip ends with score 1", async () => {
		const slug = `${NS}-vote-rt`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "rt"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score"]},
			{cookie: voter.cookie},
		);
		await h.fate(
			{kind: "mutation", name: "definition.retractVote", input: {id}, select: ["score"]},
			{cookie: voter.cookie},
		);
		const final = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "myVote"]},
			{cookie: voter.cookie},
		);
		expect(final.ok).toBe(true);
		if (!final.ok) return;
		expect((final.data as DefNode).score).toBe(1);
		expect((final.data as DefNode).myVote).toBe(true);
	});

	it("voting a missing definition surfaces DEFINITION_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "definition.vote",
				input: {id: `def_${NS}_does_not_exist`},
				select: ["score"],
			},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("DEFINITION_NOT_FOUND");
	});

	// The self-vote block (#2216) proven end-to-end through the real mutation, not just the
	// domain unit (self-vote-guard.unit.test.ts): `author` is a promoted yazar, so it clears
	// the earn-to-vote gate (#1810) and it is the self-vote guard specifically that rejects a
	// cast on its own definition with the `SELF_VOTE_NOT_ALLOWED` wire code the client receives.
	it("definition.vote by the definition's own author is rejected with SELF_VOTE_NOT_ALLOWED", async () => {
		const slug = `${NS}-self-vote`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "a self-vote target"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const result = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id}, select: ["score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("SELF_VOTE_NOT_ALLOWED");

		// The rejected cast wrote nothing: the definition is still at score 0 with no vote stamped.
		const detail = await h.fate(
			{kind: "mutation", name: "definition.retractVote", input: {id}, select: ["score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(detail.ok).toBe(true);
		if (!detail.ok) return;
		expect((detail.data as DefNode).score).toBe(0);
		expect((detail.data as DefNode).myVote).toBe(false);
	});

	// The guard is cast-only (#2216): the author retracting a vote on its own definition is
	// exempt — a retract by the owner is not rejected (here a no-op, since no vote was cast).
	it("definition.retractVote by the definition's own author is NOT rejected (cast-only guard)", async () => {
		const slug = `${NS}-self-retract-exempt`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "a self-retract exempt target"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const result = await h.fate(
			{kind: "mutation", name: "definition.retractVote", input: {id}, select: ["score", "myVote"]},
			{cookie: author.cookie},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect((result.data as DefNode).score).toBe(0);
		expect((result.data as DefNode).myVote).toBe(false);
	});
});

describe("sozluk mutations — definition.edit", () => {
	it("returns the edited entity", async () => {
		const slug = `${NS}-edit`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "before edit"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const edited = await h.fate(
			{
				kind: "mutation",
				name: "definition.edit",
				input: {id, body: "after edit"},
				select: ["id", "body"],
			},
			{cookie: author.cookie},
		);
		expect(edited.ok).toBe(true);
		if (!edited.ok) return;
		expect((edited.data as DefNode).id).toBe(id);
		expect((edited.data as DefNode).body).toBe("after edit");
	});

	// The pure definition-body codes (BODY_REQUIRED / BODY_TOO_LONG) on edit are
	// unit-tested off-DB in worker/features/sozluk/definition-validation.unit.test.ts
	// (ADR 0082) — editDefinition calls validateBody before any DB read.

	it("ownership: a non-author edit is rejected with UNAUTHORIZED; the body is unchanged", async () => {
		const slug = `${NS}-edit-cross`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "owner's body"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const result = await h.fate(
			{
				kind: "mutation",
				name: "definition.edit",
				input: {id, body: "i should not be able to write this"},
				select: ["id"],
			},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		// The original body survived.
		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["definitions.id", "definitions.body"],
		});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		const node = (term.data as {definitions: Connection<DefNode>}).definitions.items.find(
			(e) => e.node.id === id,
		);
		expect(node!.node.body).toBe("owner's body");
	});
});

describe("sozluk mutations — definition.delete", () => {
	it("returns the re-resolved parent Term and decrements its aggregates", async () => {
		const slug = `${NS}-del`;
		const a = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "to be deleted"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!a.ok) return;
		const aId = (a.data as DefNode).id;
		const b = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "the survivor"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!b.ok) return;
		const survivorId = (b.data as DefNode).id;

		// Vote the doomed definition (as a non-author — self-vote is blocked, #2216) so
		// totalScore is observably 1 before delete.
		await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: aId}, select: ["score"]},
			{cookie: voter.cookie},
		);

		const before = await h.fate({
			kind: "query",
			name: "term",
			args: {slug},
			select: ["count", "totalScore"],
		});
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect((before.data as TermNode).count).toBe(2);
		expect((before.data as TermNode).totalScore).toBe(1);

		const deleted = await h.fate(
			{
				kind: "mutation",
				name: "definition.delete",
				input: {id: aId},
				select: ["slug", "count", "totalScore"],
			},
			{cookie: author.cookie},
		);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		const term = deleted.data as TermNode;
		expect(term.__typename).toBe("Term");
		expect(term.slug).toBe(slug);
		// One definition remains; the deleted one's score is gone.
		expect(term.count).toBe(1);
		expect(term.totalScore).toBe(0);

		// The survivor is the only definition left.
		const remaining = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["definitions.id"],
		});
		expect(remaining.ok).toBe(true);
		if (!remaining.ok) return;
		const ids = (remaining.data as {definitions: Connection<DefNode>}).definitions.items.map(
			(e) => e.node.id,
		);
		expect(ids).toEqual([survivorId]);
	});

	it("ownership: a non-author delete is rejected with UNAUTHORIZED; the count is unchanged", async () => {
		const slug = `${NS}-del-cross`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "owner's body to defend"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const result = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id}, select: ["slug"]},
			{cookie: intruder.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");

		const term = await h.fate({kind: "query", name: "term", args: {slug}, select: ["count"]});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		expect((term.data as TermNode).count).toBe(1);
	});

	it("re-deleting an already-deleted definition still returns the Term with unchanged count", async () => {
		const slug = `${NS}-del-idem`;
		const a = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "anchor"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		if (!a.ok) return;
		const aId = (a.data as DefNode).id;
		await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, body: "second"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);

		const first = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id: aId}, select: ["slug", "count"]},
			{cookie: author.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as TermNode).count).toBe(1);

		// Re-delete: the row is already soft-deleted; the Term is still returned
		// with the same (unchanged) count. (The old `{deleted:false}` flag is not
		// on the wire.)
		const second = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id: aId}, select: ["slug", "count"]},
			{cookie: author.cookie},
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect((second.data as TermNode).__typename).toBe("Term");
		expect((second.data as TermNode).slug).toBe(slug);
		expect((second.data as TermNode).count).toBe(1);
	});
});

describe("sozluk mutations — seed idempotency / emptying a term", () => {
	it("seedTerm is idempotent: re-seeding the same definition skips it", async () => {
		const slug = `${NS}-outbox`;
		const def = {
			authorName: "anka",
			body: "Atomic durability primitive in the producer-consumer outbox pattern.",
		};

		const first = await h.seedTerm({slug, title: "Outbox", definitions: [def]});
		expect(first.insertedDefinitions).toBe(1);
		expect(first.skippedDefinitions).toBe(0);

		const second = await h.seedTerm({slug, title: "Outbox", definitions: [def]});
		expect(second.insertedDefinitions).toBe(0);
		expect(second.skippedDefinitions).toBe(1);

		const term = await h.fate({kind: "query", name: "term", args: {slug}, select: ["count"]});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		expect((term.data as TermNode).count).toBe(1);
	});

	// The old admin `clear` route is gone (it was a fail-open security hole). The
	// public surface has no term-wipe, so the equivalent observable behavior is:
	// soft-deleting every definition empties the term — `count` → 0 and the
	// `definitions` connection is empty. (The `term_record` row persists, so the
	// term still resolves; it just has no live definitions.)
	it("deleting the term's only definition empties it (count 0, no definitions)", async () => {
		const slug = `${NS}-transient`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: slug, termTitle: "Transient", body: "Short-lived state."},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const id = (added.data as DefNode).id;

		const deleted = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id}, select: ["slug", "count"]},
			{cookie: author.cookie},
		);
		expect(deleted.ok).toBe(true);

		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug, definitions: {first: 10}},
			select: ["count", "definitions.id"],
		});
		expect(term.ok).toBe(true);
		if (!term.ok) return;
		const t = term.data as TermNode & {definitions: Connection<DefNode>};
		expect(t.count).toBe(0);
		expect(t.definitions.items).toEqual([]);
	});
});
