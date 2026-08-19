/**
 * çaylak in-place visibility end to end (#6424, epic #4306) — black-box over the deployed
 * worker's `/fate` route against real remote D1 (ADR 0082/0154).
 *
 * The unit tier proves the SQL each read emits per viewer shape. What only real D1 can
 * answer is the ROW question: with `phoenix-caylak-visibility` on and the yazar opted in,
 * does a still-sandboxed çaylak post/comment/definition actually come back — and does it
 * stay hidden from everyone else. Four viewer shapes are driven against one fixture:
 * the opted-in yazar, a yazar who did not opt in, an anonymous visitor, and the opted-in
 * yazar again with the flag OFF.
 *
 * Its own DEDICATED per-file stage (`integrationStack`), not the shared one: the term
 * REACHABILITY assertion reads the global `recentTerms` list, whose corpus a parallel
 * fork's writes would otherwise mutate between requests — the paged-walk rule of ADR 0104,
 * applied to a list-membership assertion for the same reason.
 *
 * The flag is forced per request with the `phoenix_flag_overrides` cookie (#622), honored
 * only because the integration stage runs `ENVIRONMENT=development`.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = integrationStack(import.meta.url);

const NS = nsToken(import.meta.url);
const HOST = `${NS}-caylak.example.com`;
const TERM_SLUG = `${NS}-caylak-terim`;

const FLAG_ON = `phoenix_flag_overrides=${encodeURIComponent(
	JSON.stringify({"phoenix-caylak-visibility": true}),
)}`;

interface Node {
	id: string;
}
type Connection<N> = {
	items: Array<{cursor: string; node: N}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
};

let caylak: {userId: string; cookie: string};
/** The yazar who opts in — the third viewer class. */
let optedIn: {userId: string; cookie: string};
/** A yazar who never opts in — the unchanged-signed-in-reader control. */
let control: {userId: string; cookie: string};

/** The çaylak's still-sandboxed post, comment and definition. */
let sandboxedPostId = "";
let sandboxedCommentId = "";
let sandboxedDefinitionId = "";
/** A yazar-authored (live) post, used as the thread the çaylak comments on. */
let livePostId = "";

const idOf = (result: Awaited<ReturnType<typeof h.fate>>, what: string): string => {
	if (!result.ok) throw new Error(`seed ${what} failed: ${result.error.code}`);
	return (result.data as Node).id;
};

beforeAll(async () => {
	// A bare sign-up is a çaylak (the `user.tier` default), so everything it authors lands
	// sandboxed — that IS the fixture. `signUpYazar` is the promoted, live-authoring form.
	caylak = await h.signUp(`${NS}-caylak@test.local`, "hunter2hunter2", "çaylak");
	optedIn = await h.signUpYazar(`${NS}-optedin@test.local`, "hunter2hunter2", "yazar");
	control = await h.signUpYazar(`${NS}-control@test.local`, "hunter2hunter2", "kontrol");

	livePostId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `${NS} canlı gönderi`,
					url: `https://${HOST}/live`,
					tags: [{kind: "soru"}],
				},
				select: ["id"],
			},
			{cookie: optedIn.cookie},
		),
		"the live host post",
	);

	sandboxedPostId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `${NS} çaylak gönderisi`,
					url: `https://${HOST}/caylak`,
					tags: [{kind: "soru"}],
				},
				select: ["id"],
			},
			{cookie: caylak.cookie},
		),
		"the çaylak post",
	);

	sandboxedCommentId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: livePostId, body: "çaylak yorumu — yeterince uzun"},
				select: ["id"],
			},
			{cookie: caylak.cookie},
		),
		"the çaylak comment",
	);

	sandboxedDefinitionId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: TERM_SLUG, termTitle: TERM_SLUG, body: "çaylak tanımı — yeterince uzun"},
				select: ["id"],
			},
			{cookie: caylak.cookie},
		),
		"the çaylak definition",
	);

	// The opt-in itself. It is flag-gated, so it only lands with the override cookie.
	const optIn = await h.fate(
		{kind: "mutation", name: "caylakVisibility.optIn", input: {}, select: ["optedIn"]},
		{cookie: `${optedIn.cookie}; ${FLAG_ON}`, retry: true},
	);
	// SETUP DISCRIMINATOR: every assertion below rests on this write. Assert it on the
	// direct response so a refused opt-in fails HERE, named, instead of masquerading as
	// "the feature does not work" in each read below.
	expect(optIn.ok).toBe(true);
	if (!optIn.ok) throw new Error(`seed caylakVisibility.optIn failed: ${optIn.error.code}`);
	expect((optIn.data as {optedIn: boolean}).optedIn).toBe(true);
});

/** The pano feed, scoped to this file's host so the assertion sees only its own rows. */
const feedIds = async (cookie?: string): Promise<string[]> => {
	const result = await h.fate(
		{kind: "list", name: "posts", args: {sort: "new", host: HOST}, select: ["id", "title"]},
		cookie === undefined ? {} : {cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return [];
	return (result.data as Connection<Node>).items.map((edge) => edge.node.id);
};

const postDetail = async (id: string, cookie?: string): Promise<Node | null> => {
	const result = await h.fate(
		{kind: "query", name: "post", args: {idOrSlug: id}, select: ["id", "title"]},
		cookie === undefined ? {} : {cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return null;
	return result.data as Node | null;
};

const threadCommentIds = async (cookie?: string): Promise<string[]> => {
	const result = await h.fate(
		{
			kind: "query",
			name: "post",
			args: {idOrSlug: livePostId},
			select: ["id", "comments.id", "comments.body"],
		},
		cookie === undefined ? {} : {cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return [];
	const data = result.data as {comments?: Connection<Node>} | null;
	return (data?.comments?.items ?? []).map((edge) => edge.node.id);
};

const termDefinitionIds = async (cookie?: string): Promise<string[]> => {
	const result = await h.fate(
		{
			kind: "query",
			name: "term",
			args: {slug: TERM_SLUG},
			select: ["id", "slug", "definitions.id", "definitions.body"],
		},
		cookie === undefined ? {} : {cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return [];
	const data = result.data as {definitions?: Connection<Node>} | null;
	return (data?.definitions?.items ?? []).map((edge) => edge.node.id);
};

/** Is the sandbox-only term reachable from the term list for this viewer? */
const termIsListed = async (cookie?: string): Promise<boolean> => {
	const result = await h.fate(
		{kind: "list", name: "recentTerms", args: {first: 50}, select: ["id", "slug"]},
		cookie === undefined ? {} : {cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return false;
	return (result.data as Connection<{id: string; slug: string}>).items.some(
		(edge) => edge.node.slug === TERM_SLUG,
	);
};

describe("çaylak in-place visibility — the opted-in yazar sees it in place (#6424)", () => {
	const cookie = () => `${optedIn.cookie}; ${FLAG_ON}`;

	it("the çaylak's still-sandboxed post appears in the pano feed", async () => {
		expect(await feedIds(cookie())).toContain(sandboxedPostId);
	});

	it("the çaylak's still-sandboxed post resolves on the detail page", async () => {
		expect(await postDetail(sandboxedPostId, cookie())).not.toBeNull();
	});

	it("the çaylak's still-sandboxed comment appears in the thread", async () => {
		expect(await threadCommentIds(cookie())).toContain(sandboxedCommentId);
	});

	it("the çaylak's still-sandboxed definition appears on the term page", async () => {
		expect(await termDefinitionIds(cookie())).toContain(sandboxedDefinitionId);
	});

	it("a term whose only definitions are sandboxed becomes reachable", async () => {
		expect(await termIsListed(cookie())).toBe(true);
	});
});

describe("çaylak in-place visibility — nobody else sees anything new (#6424)", () => {
	const anonymous = FLAG_ON;
	const notOptedIn = () => `${control.cookie}; ${FLAG_ON}`;
	// The same opted-in reader with NO override cookie: the flag's default-off value
	// applies, which is the dark-ship containment.
	const flagOff = () => optedIn.cookie;

	for (const [name, cookie] of [
		["an anonymous visitor", () => anonymous],
		["a yazar who did not opt in", notOptedIn],
		["the opted-in yazar with the flag OFF", flagOff],
	] as ReadonlyArray<[string, () => string]>) {
		it(`${name} does not see the sandboxed post in the feed`, async () => {
			expect(await feedIds(cookie())).not.toContain(sandboxedPostId);
		});

		it(`${name} reads the sandboxed post detail as not-found`, async () => {
			expect(await postDetail(sandboxedPostId, cookie())).toBeNull();
		});

		it(`${name} does not see the sandboxed comment in the thread`, async () => {
			expect(await threadCommentIds(cookie())).not.toContain(sandboxedCommentId);
		});

		it(`${name} does not see the sandboxed definition on the term page`, async () => {
			expect(await termDefinitionIds(cookie())).not.toContain(sandboxedDefinitionId);
		});

		it(`${name} cannot reach the sandbox-only term from the term list`, async () => {
			expect(await termIsListed(cookie())).toBe(false);
		});
	}

	it("the live host post stays visible to everyone — the widening is additive only", async () => {
		expect(await feedIds(anonymous)).toContain(livePostId);
		expect(await feedIds(`${optedIn.cookie}; ${FLAG_ON}`)).toContain(livePostId);
	});
});
