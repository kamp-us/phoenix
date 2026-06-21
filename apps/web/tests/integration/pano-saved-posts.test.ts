/**
 * pano saved-posts list (`savedPosts`) — black-box against the deployed worker
 * `/fate` route (ADR 0026–0031, ADR 0082).
 *
 * Drives the `savedPosts` keyset connection #676 adds: a `Bookmark`-driven page
 * over `post_summary`, `CurrentUser`-scoped, ordered by save time
 * (`post_bookmark.created_at DESC, post_id DESC`). Everything is observed over
 * HTTP — saves are made through `post.save`, the list is read back per viewer.
 * The keyset *predicate shape* + cursor-miss/envelope *decision* are pure and
 * unit-tested (`worker/db/keyset.unit.test.ts`); what stays here is the
 * irreducible real-D1 core (ADR 0082): how the engine executes the bookmark
 * keyset across page boundaries, per-viewer scoping, the `isSaved` stamp, and
 * the anonymous empty page.
 *
 * Save order is the keyset lead column: saves are stamped `new Date()` in the
 * service, so saving in sequence builds an ascending `created_at` and the list
 * returns them newest-save-first. Same-millisecond ties are broken by `post_id`
 * desc, so the order is deterministic either way — assertions check the
 * membership + no-skips/dupes invariant, and the concrete order where the saves
 * are clearly sequenced.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1 is
 * shared across every migrated file: every email/title is prefixed with `NS` (this file's
 * deterministic `nsToken`). The list is `CurrentUser`-scoped, so every assertion reads the
 * viewer's own saves and `.filter`s to this file's own NS post ids — its rows are its own.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	isSaved: boolean | null;
}

type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let saver: {userId: string; cookie: string};
let other: {userId: string; cookie: string};

/** Submit a post under the saver cookie; return its id. */
async function seedPost(title: string): Promise<string> {
	const r = await h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title, tags: [{kind: "tartışma"}]},
			select: ["id"],
		},
		{cookie: saver.cookie},
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("seedPost failed");
	return (r.data as PostNode).id;
}

/** Save a post under a cookie; assert the toggle landed. */
async function save(id: string, cookie: string): Promise<void> {
	const r = await h.fate(
		{kind: "mutation", name: "post.save", input: {id}, select: ["id", "isSaved"]},
		{cookie},
	);
	expect(r.ok).toBe(true);
}

/** Read a page of the saved-posts list for a cookie (anonymous when omitted). */
async function savedPage(
	cookie: string | undefined,
	args: {first?: number; after?: string} = {},
): Promise<Connection<PostNode>> {
	const r = await h.fate(
		{kind: "list", name: "savedPosts", args, select: ["id", "title", "isSaved"]},
		cookie ? {cookie} : undefined,
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("savedPosts list failed");
	return r.data as Connection<PostNode>;
}

beforeAll(async () => {
	saver = await h.signUp(`${NS}-saver@test.local`, "hunter2hunter2", "kaydeden");
	other = await h.signUp(`${NS}-other@test.local`, "hunter2hunter2", "öteki");
});

describe("pano savedPosts — viewer-scoped saved list", () => {
	it("returns an empty connection for an anonymous viewer", async () => {
		const conn = await savedPage(undefined);
		expect(conn.items).toEqual([]);
		expect(conn.pagination.hasNext).toBe(false);
	});

	it("returns only the viewer's own saves, each stamped isSaved=true", async () => {
		const mine1 = await seedPost(`${NS} mine 1`);
		const mine2 = await seedPost(`${NS} mine 2`);
		const theirs = await seedPost(`${NS} theirs`);

		await save(mine1, saver.cookie);
		await save(mine2, saver.cookie);
		await save(theirs, other.cookie);

		const mineIds = new Set([mine1, mine2]);
		const conn = await savedPage(saver.cookie, {first: 50});
		const seen = conn.items.map((e) => e.node).filter((n) => mineIds.has(n.id) || n.id === theirs);

		// The saver sees mine1 + mine2, never `theirs` (which `other` saved).
		expect(seen.map((n) => n.id).sort()).toEqual([mine1, mine2].sort());
		expect(seen.every((n) => n.isSaved === true)).toBe(true);
		expect(seen.some((n) => n.id === theirs)).toBe(false);

		// `other` sees the mirror image: `theirs`, never mine1/mine2.
		const otherConn = await savedPage(other.cookie, {first: 50});
		const otherSeen = otherConn.items
			.map((e) => e.node)
			.filter((n) => mineIds.has(n.id) || n.id === theirs);
		expect(otherSeen.map((n) => n.id)).toEqual([theirs]);
	});

	it("a post the viewer un-saves leaves the list", async () => {
		const keep = await seedPost(`${NS} keep`);
		const drop = await seedPost(`${NS} drop`);
		await save(keep, saver.cookie);
		await save(drop, saver.cookie);

		const before = await savedPage(saver.cookie, {first: 50});
		expect(before.items.some((e) => e.node.id === drop)).toBe(true);

		const unsave = await h.fate(
			{kind: "mutation", name: "post.unsave", input: {id: drop}, select: ["id"]},
			{cookie: saver.cookie},
		);
		expect(unsave.ok).toBe(true);

		const after = await savedPage(saver.cookie, {first: 50});
		expect(after.items.some((e) => e.node.id === drop)).toBe(false);
		expect(after.items.some((e) => e.node.id === keep)).toBe(true);
	});
});

describe("pano savedPosts — keyset ordering + pagination on real D1", () => {
	// Save four fresh posts in sequence; the list returns them newest-save-first.
	const ORDER_TITLES = [0, 1, 2, 3].map((i) => `${NS} order ${i}`);
	const orderIds: string[] = [];

	beforeAll(async () => {
		for (const title of ORDER_TITLES) {
			const id = await seedPost(title);
			await save(id, saver.cookie);
			orderIds.push(id);
		}
	});

	it("orders by save time desc (newest save first), cursor = post id", async () => {
		const conn = await savedPage(saver.cookie, {first: 50});
		const ourIndex = new Map(orderIds.map((id, i) => [id, i]));
		const seen = conn.items.filter((e) => ourIndex.has(e.node.id));

		// Saved 0→1→2→3, so the list leads with 3, 2, 1, 0 among our rows.
		expect(seen.map((e) => e.node.id)).toEqual([...orderIds].reverse());
		for (const e of seen) {
			expect(e.cursor).toBe(e.node.id); // cursor IS the post-id keyset
		}
	});

	it("paginates across a boundary with no skips/dupes", async () => {
		const seen: string[] = [];
		let after: string | undefined;
		let safety = 0;
		const ours = new Set(orderIds);
		while (safety++ < 50) {
			const conn = await savedPage(saver.cookie, after ? {first: 2, after} : {first: 2});
			for (const e of conn.items) {
				if (ours.has(e.node.id)) seen.push(e.node.id);
			}
			if (!conn.pagination.hasNext) break;
			after = conn.pagination.nextCursor;
			expect(after).toBeDefined();
		}
		// Every saved post seen exactly once, in newest-save-first order.
		expect(seen).toEqual([...orderIds].reverse());
		expect(new Set(seen).size).toBe(orderIds.length);
	});
});
