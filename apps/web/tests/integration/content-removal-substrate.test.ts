/**
 * The uniform removal substrate (ADR 0096) — black-box against the deployed
 * worker `/fate` route on real remote D1 (ADR 0082 integration tier).
 *
 * Proves the two substrate guarantees per entity type (definition / post / comment):
 * remove → restore reversibility (ADR 0096 §4), and karma KEPT across removal (§3 — the
 * score cache drops to 0 as votes are wiped, but the author's karma credential is stable).
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7): every email/slug/username is
 * `NS`-prefixed and karma is asserted per-author off this file's own NS-username.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
let counter = 0;
const uname = (label: string) => `${NS}-${label}-${counter++}`;

interface ProfileNode {
	totalKarma: number;
}

// `Term.definitions` is a paginated `FateDataView.list` connection (sozluk
// `views.ts`), not a bare array — `{items: [{node}]}`, matching `sozluk-keyset`.
type Connection<N> = {items: Array<{cursor: string; node: N}>};
const definitionIds = (data: unknown): string[] =>
	(data as {definitions: Connection<{id: string}>}).definitions.items.map((e) => e.node.id);

async function setUsername(cookie: string, value: string): Promise<void> {
	const r = await h.fate(
		{kind: "mutation", name: "user.setUsername", input: {value}, select: ["id"]},
		{cookie},
	);
	expect(r.ok).toBe(true);
}

beforeAll(() => {
	expect(typeof h.url()).toBe("string");
});

describe("removal substrate — definition remove → restore, karma kept", () => {
	it("a removed definition leaves the term and restores; the author's karma is unchanged", async () => {
		const authorUsername = uname("def");
		const author = await h.signUpYazar(`${NS}-def@test.local`, "hunter2hunter2", "Def Author");
		await setUsername(author.cookie, authorUsername);

		const termSlug = `${NS}-def-term`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug, termTitle: "Removal Term", body: "a definition to remove and restore"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		const karmaOf = async (): Promise<number> => {
			const res = await h.fate({
				kind: "query",
				name: "profile",
				args: {username: authorUsername},
				select: ["totalKarma"],
			});
			expect(res.ok).toBe(true);
			if (!res.ok) throw new Error("profile read failed");
			return (res.data as ProfileNode).totalKarma;
		};

		// Promoted to yazar so it clears the #1810 "earn to vote" gate (a fresh çaylak is
		// rejected at cast).
		const voter = await h.signUp(`${NS}-def-v@test.local`, "hunter2hunter2", "Voter");
		await h.promoteToYazar(voter.userId);
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		const termBefore = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id"],
		});
		expect(termBefore.ok).toBe(true);
		if (termBefore.ok) {
			expect(definitionIds(termBefore.data)).toContain(definitionId);
		}

		const del = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id: definitionId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		const termAfter = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id"],
		});
		expect(termAfter.ok).toBe(true);
		if (termAfter.ok) {
			expect(definitionIds(termAfter.data)).not.toContain(definitionId);
		}

		expect(await karmaOf()).toBe(1);

		const restored = await h.fate(
			{kind: "mutation", name: "definition.restore", input: {id: definitionId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(restored.ok).toBe(true);

		const termRestored = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id"],
		});
		expect(termRestored.ok).toBe(true);
		if (termRestored.ok) {
			expect(definitionIds(termRestored.data)).toContain(definitionId);
		}
		expect(await karmaOf()).toBe(1);
	});
});

describe("removal substrate — post remove → restore, karma kept", () => {
	it("a removed post disappears and restores; the author's karma is unchanged", async () => {
		const authorUsername = uname("post");
		const author = await h.signUpYazar(`${NS}-post@test.local`, "hunter2hunter2", "Post Author");
		await setUsername(author.cookie, authorUsername);

		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `${NS} post to remove`,
					url: `https://example.com/${NS}`,
					tags: [{kind: "tartışma"}],
				},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		const postId = (submitted.data as {id: string}).id;

		const karmaOf = async (): Promise<number> => {
			const res = await h.fate({
				kind: "query",
				name: "profile",
				args: {username: authorUsername},
				select: ["totalKarma"],
			});
			if (!res.ok) throw new Error("profile read failed");
			return (res.data as ProfileNode).totalKarma;
		};

		// Promoted to yazar so it clears the #1810 "earn to vote" gate.
		const voter = await h.signUp(`${NS}-post-v@test.local`, "hunter2hunter2", "Voter");
		await h.promoteToYazar(voter.userId);
		const vote = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: postId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		const del = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: postId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		// A removed post reads as null, exactly like an unknown id (ADR 0096 §1/§5).
		const gone = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			select: ["id"],
		});
		expect(gone.ok).toBe(true);
		if (gone.ok) expect(gone.data).toBeNull();

		expect(await karmaOf()).toBe(1);

		const restored = await h.fate(
			{kind: "mutation", name: "post.restore", input: {id: postId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(restored.ok).toBe(true);

		const back = await h.fate({
			kind: "query",
			name: "post",
			args: {idOrSlug: postId},
			select: ["id"],
		});
		expect(back.ok).toBe(true);
		if (back.ok) expect((back.data as {id: string} | null)?.id).toBe(postId);

		expect(await karmaOf()).toBe(1);
	});
});

describe("removal substrate — comment remove → restore, karma kept", () => {
	it("a removed comment tombstones and restores; the author's karma is unchanged", async () => {
		const authorUsername = uname("cmt");
		const author = await h.signUpYazar(`${NS}-cmt@test.local`, "hunter2hunter2", "Cmt Author");
		await setUsername(author.cookie, authorUsername);

		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `${NS} comment host`,
					url: `https://example.com/${NS}-host`,
					tags: [{kind: "tartışma"}],
				},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		const postId = (submitted.data as {id: string}).id;

		const added = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "a comment to remove and restore"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const commentId = (added.data as {id: string}).id;

		const karmaOf = async (): Promise<number> => {
			const res = await h.fate({
				kind: "query",
				name: "profile",
				args: {username: authorUsername},
				select: ["totalKarma"],
			});
			if (!res.ok) throw new Error("profile read failed");
			return (res.data as ProfileNode).totalKarma;
		};

		// Promoted to yazar so it clears the #1810 "earn to vote" gate.
		const voter = await h.signUp(`${NS}-cmt-v@test.local`, "hunter2hunter2", "Voter");
		await h.promoteToYazar(voter.userId);
		const vote = await h.fate(
			{kind: "mutation", name: "comment.vote", input: {id: commentId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		const commentIdsOf = async (): Promise<string[]> => {
			const res = await h.fate({
				kind: "query",
				name: "post",
				args: {idOrSlug: postId},
				select: ["comments.id"],
			});
			if (!res.ok) throw new Error("post read failed");
			// `comments` is a paginated connection (`{items: [{node}]}`), not a bare array.
			const data = res.data as {comments?: Connection<{id: string}>} | null;
			return (data?.comments?.items ?? []).map((e) => e.node.id);
		};

		expect(await commentIdsOf()).toContain(commentId);

		const del = await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: commentId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);
		expect(await commentIdsOf()).not.toContain(commentId);

		expect(await karmaOf()).toBe(1);

		const restored = await h.fate(
			{kind: "mutation", name: "comment.restore", input: {id: commentId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(restored.ok).toBe(true);
		expect(await commentIdsOf()).toContain(commentId);

		expect(await karmaOf()).toBe(1);
	});
});
