/**
 * The uniform removal substrate (ADR 0096) — black-box against the deployed
 * worker `/fate` route on real remote D1 (ADR 0082 integration tier).
 *
 * Proves the two substrate guarantees end to end, per entity type
 * (definition / post / comment):
 *   - **Remove → restore round-trip.** A removed entity disappears from public
 *     reads; restoring it brings the content back (reversibility, ADR 0096 §4).
 *   - **Karma is KEPT across removal.** An up-vote bumps the author's
 *     `total_karma`; removing the voted-on content does NOT reverse it (ADR 0096
 *     §3, the pano karma-reversal deleted). The score *cache* drops to 0 (votes
 *     wiped by `Vote.clearTarget`), but the author's karma credential is stable.
 *
 * Everything is observed over HTTP; every email/slug/username is `rm-${STAMP}-…`
 * prefixed for this file's isolated stage.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now().toString(36);
let counter = 0;
const uname = (label: string) => `rm-${STAMP}-${label}-${counter++}`;

interface ProfileNode {
	totalKarma: number;
}

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
		const author = await h.signUp(`rm-${STAMP}-def@test.local`, "hunter2hunter2", "Def Author");
		await setUsername(author.cookie, authorUsername);

		const termSlug = `rm-${STAMP}-def-term`;
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

		// A distinct voter up-votes the definition → author karma 1.
		const voter = await h.signUp(`rm-${STAMP}-def-v@test.local`, "hunter2hunter2", "Voter");
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		// The term page lists the live definition.
		const termBefore = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id"],
		});
		expect(termBefore.ok).toBe(true);
		if (termBefore.ok) {
			const ids = (termBefore.data as {definitions: Array<{id: string}>}).definitions.map(
				(d) => d.id,
			);
			expect(ids).toContain(definitionId);
		}

		// The author removes it.
		const del = await h.fate(
			{kind: "mutation", name: "definition.delete", input: {id: definitionId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		// Gone from the public term page…
		const termAfter = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id"],
		});
		expect(termAfter.ok).toBe(true);
		if (termAfter.ok) {
			const ids = (termAfter.data as {definitions: Array<{id: string}>}).definitions.map(
				(d) => d.id,
			);
			expect(ids).not.toContain(definitionId);
		}

		// …but karma is KEPT (the upvote earned is not reversed by removal).
		expect(await karmaOf()).toBe(1);

		// Restore brings the definition back to the term.
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
			const ids = (termRestored.data as {definitions: Array<{id: string}>}).definitions.map(
				(d) => d.id,
			);
			expect(ids).toContain(definitionId);
		}
		// Karma still 1 after the whole round-trip.
		expect(await karmaOf()).toBe(1);
	});
});

describe("removal substrate — post remove → restore, karma kept", () => {
	it("a removed post disappears and restores; the author's karma is unchanged", async () => {
		const authorUsername = uname("post");
		const author = await h.signUp(`rm-${STAMP}-post@test.local`, "hunter2hunter2", "Post Author");
		await setUsername(author.cookie, authorUsername);

		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `rm-${STAMP} post to remove`,
					url: `https://example.com/rm-${STAMP}`,
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

		const voter = await h.signUp(`rm-${STAMP}-post-v@test.local`, "hunter2hunter2", "Voter");
		const vote = await h.fate(
			{kind: "mutation", name: "post.vote", input: {id: postId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		// Remove the post.
		const del = await h.fate(
			{kind: "mutation", name: "post.delete", input: {id: postId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);

		// The post is no longer publicly resolvable…
		const gone = await h.fate({kind: "query", name: "post", args: {id: postId}, select: ["id"]});
		expect(gone.ok).toBe(true);
		if (gone.ok) expect(gone.data).toBeNull();

		// …karma KEPT.
		expect(await karmaOf()).toBe(1);

		// Restore re-resolves the post.
		const restored = await h.fate(
			{kind: "mutation", name: "post.restore", input: {id: postId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(restored.ok).toBe(true);

		const back = await h.fate({kind: "query", name: "post", args: {id: postId}, select: ["id"]});
		expect(back.ok).toBe(true);
		if (back.ok) expect((back.data as {id: string} | null)?.id).toBe(postId);

		expect(await karmaOf()).toBe(1);
	});
});

describe("removal substrate — comment remove → restore, karma kept", () => {
	it("a removed comment tombstones and restores; the author's karma is unchanged", async () => {
		const authorUsername = uname("cmt");
		const author = await h.signUp(`rm-${STAMP}-cmt@test.local`, "hunter2hunter2", "Cmt Author");
		await setUsername(author.cookie, authorUsername);

		// A post to hang the comment on.
		const submitted = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `rm-${STAMP} comment host`,
					url: `https://example.com/rm-${STAMP}-host`,
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

		const voter = await h.signUp(`rm-${STAMP}-cmt-v@test.local`, "hunter2hunter2", "Voter");
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
				args: {id: postId},
				select: ["comments.id"],
			});
			if (!res.ok) throw new Error("post read failed");
			const data = res.data as {comments?: Array<{id: string}>} | null;
			return (data?.comments ?? []).map((c) => c.id);
		};

		// Live leaf comment is in the thread.
		expect(await commentIdsOf()).toContain(commentId);

		// Remove it (leaf → drops out of the thread).
		const del = await h.fate(
			{kind: "mutation", name: "comment.delete", input: {id: commentId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(del.ok).toBe(true);
		expect(await commentIdsOf()).not.toContain(commentId);

		// Karma KEPT across the comment removal.
		expect(await karmaOf()).toBe(1);

		// Restore re-appends the comment to the thread.
		const restored = await h.fate(
			{kind: "mutation", name: "comment.restore", input: {id: commentId}, select: ["id"]},
			{cookie: author.cookie},
		);
		expect(restored.ok).toBe(true);
		expect(await commentIdsOf()).toContain(commentId);

		expect(await karmaOf()).toBe(1);
	});
});
