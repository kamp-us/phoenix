/**
 * pano bookmarks ("kaydet") — black-box against the deployed worker `/fate` route
 * (ADR 0026–0031, ADR 0082).
 *
 * Drives the `isSaved` viewer scalar + the `post.save` / `post.unsave` mutations
 * #128 adds, the structural twin of `post.vote` / `post.retractVote` with score
 * stripped to pure presence. Everything is observed over HTTP: `isSaved` is read
 * back off `post(id)` per viewer, the mutations are exercised for the toggle round
 * trip, idempotent repeat, the anonymous rejection, and the missing-post error.
 * The no-N+1 batch stamp is asserted indirectly the way `myVote` is — a viewer's
 * saves resolve correctly across a set of posts in one read, with each viewer
 * seeing only their own.
 *
 * D1 is real remote Cloudflare D1 (per-file isolated stage); every email/title is
 * uniquely prefixed (`panobm-${STAMP}-…`) so concurrent files never collide.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now();

interface PostNode {
	__typename: string;
	id: string;
	title: string;
	score: number;
	myVote: number | null;
	isSaved: boolean | null;
}

let saver: {userId: string; cookie: string};
let other: {userId: string; cookie: string};

const POST_SELECT = ["id", "title", "score", "myVote", "isSaved"];

/** Submit a post under the saver cookie; assert success; return its id. */
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

/** Re-resolve a post's `isSaved` for the given cookie (anonymous when omitted). */
async function readIsSaved(id: string, cookie?: string): Promise<boolean | null> {
	const r = await h.fate(
		{kind: "query", name: "post", args: {idOrSlug: id}, select: ["id", "isSaved"]},
		cookie ? {cookie} : undefined,
	);
	expect(r.ok).toBe(true);
	if (!r.ok) throw new Error("readIsSaved failed");
	return (r.data as PostNode).isSaved;
}

beforeAll(async () => {
	saver = await h.signUp(`panobm-${STAMP}-saver@test.local`, "hunter2hunter2", "kaydeden");
	other = await h.signUp(`panobm-${STAMP}-other@test.local`, "hunter2hunter2", "öteki");
});

describe("pano bookmarks — isSaved view scalar", () => {
	it("resolves false for a signed-in viewer who has not saved the post", async () => {
		const id = await seedPost(`panobm-${STAMP} unsaved`);
		expect(await readIsSaved(id, saver.cookie)).toBe(false);
	});

	it("resolves null for an anonymous viewer", async () => {
		const id = await seedPost(`panobm-${STAMP} anon view`);
		expect(await readIsSaved(id)).toBeNull();
	});

	it("stamps each viewer's own saves across a set of posts (batched, no cross-talk)", async () => {
		const a = await seedPost(`panobm-${STAMP} set a`);
		const b = await seedPost(`panobm-${STAMP} set b`);
		const c = await seedPost(`panobm-${STAMP} set c`);

		// saver saves a + c; `other` saves b.
		for (const [id, cookie] of [
			[a, saver.cookie],
			[c, saver.cookie],
			[b, other.cookie],
		] as const) {
			const r = await h.fate(
				{kind: "mutation", name: "post.save", input: {id}, select: ["id", "isSaved"]},
				{cookie},
			);
			expect(r.ok).toBe(true);
		}

		// saver sees a,c saved and b not; `other` sees the mirror image.
		expect(await readIsSaved(a, saver.cookie)).toBe(true);
		expect(await readIsSaved(b, saver.cookie)).toBe(false);
		expect(await readIsSaved(c, saver.cookie)).toBe(true);
		expect(await readIsSaved(a, other.cookie)).toBe(false);
		expect(await readIsSaved(b, other.cookie)).toBe(true);
		expect(await readIsSaved(c, other.cookie)).toBe(false);
	});
});

describe("pano bookmarks — post.save / post.unsave", () => {
	it("save then unsave flip isSaved true → false and return the re-resolved Post", async () => {
		const id = await seedPost(`panobm-${STAMP} toggle`);

		const saved = await h.fate(
			{kind: "mutation", name: "post.save", input: {id}, select: POST_SELECT},
			{cookie: saver.cookie},
		);
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect((saved.data as PostNode).__typename).toBe("Post");
		expect((saved.data as PostNode).id).toBe(id);
		expect((saved.data as PostNode).isSaved).toBe(true);
		// pure presence — no score side effect (the Vote divergence)
		expect((saved.data as PostNode).score).toBe(0);

		const unsaved = await h.fate(
			{kind: "mutation", name: "post.unsave", input: {id}, select: POST_SELECT},
			{cookie: saver.cookie},
		);
		expect(unsaved.ok).toBe(true);
		if (!unsaved.ok) return;
		expect((unsaved.data as PostNode).isSaved).toBe(false);
		expect((unsaved.data as PostNode).score).toBe(0);
	});

	it("is idempotent: re-saving an already-saved post stays isSaved true", async () => {
		const id = await seedPost(`panobm-${STAMP} idempotent`);

		const first = await h.fate(
			{kind: "mutation", name: "post.save", input: {id}, select: POST_SELECT},
			{cookie: saver.cookie},
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect((first.data as PostNode).isSaved).toBe(true);

		const again = await h.fate(
			{kind: "mutation", name: "post.save", input: {id}, select: POST_SELECT},
			{cookie: saver.cookie},
		);
		expect(again.ok).toBe(true);
		if (!again.ok) return;
		expect((again.data as PostNode).isSaved).toBe(true);

		// And re-unsaving an already-unsaved post stays false.
		await h.fate(
			{kind: "mutation", name: "post.unsave", input: {id}, select: ["id"]},
			{cookie: saver.cookie},
		);
		const repeatUnsave = await h.fate(
			{kind: "mutation", name: "post.unsave", input: {id}, select: POST_SELECT},
			{cookie: saver.cookie},
		);
		expect(repeatUnsave.ok).toBe(true);
		if (!repeatUnsave.ok) return;
		expect((repeatUnsave.data as PostNode).isSaved).toBe(false);
	});

	it("an anonymous save is rejected with UNAUTHORIZED", async () => {
		const id = await seedPost(`panobm-${STAMP} anon save`);
		const result = await h.fate({
			kind: "mutation",
			name: "post.save",
			input: {id},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});

	it("an anonymous unsave is rejected with UNAUTHORIZED", async () => {
		const id = await seedPost(`panobm-${STAMP} anon unsave`);
		const result = await h.fate({
			kind: "mutation",
			name: "post.unsave",
			input: {id},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});

	it("saving a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.save",
				input: {id: `post_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: saver.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});

	it("unsaving a missing post surfaces POST_NOT_FOUND", async () => {
		const result = await h.fate(
			{
				kind: "mutation",
				name: "post.unsave",
				input: {id: `post_${STAMP}_does_not_exist`},
				select: ["id"],
			},
			{cookie: saver.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("POST_NOT_FOUND");
	});
});
