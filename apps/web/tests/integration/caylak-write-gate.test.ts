/**
 * The çaylak write gate end to end (ADR 0434, #7485) — black-box over the deployed worker's
 * `/api/auth` and `/fate` routes against real remote D1.
 *
 * With `phoenix-email-verified-writes` on, an unverified çaylak is refused post, comment and
 * definition writes with `EMAIL_UNVERIFIED`, yet can still sign in and read posts, comments and
 * definitions. Verifying the address in D1 lets the SAME session write on its next request, which
 * is what proves the gate reads `user.email_verified` fresh rather than from the session.
 *
 * The flag is forced per request with the `phoenix_flag_overrides` cookie (#622), honored only
 * because the integration stage runs `ENVIRONMENT=development`. Runs on the run-scoped SHARED
 * stage (ADR 0104): every email, host and slug is `NS`-prefixed and every assertion reads its
 * own rows.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
const HOST = `${NS}-gate.example.com`;
const TERM_SLUG = `${NS}-gate-terim`;
const PASSWORD = "hunter2hunter2";
const UNVERIFIED_EMAIL = `${NS}-unverified@test.local`;

const FLAG_ON = `phoenix_flag_overrides=${encodeURIComponent(
	JSON.stringify({"phoenix-email-verified-writes": true}),
)}`;

interface Node {
	id: string;
}
type Connection<N> = {items: Array<{cursor: string; node: N}>};

let yazar: {userId: string; cookie: string};
let unverified: {userId: string; cookie: string};
let livePostId = "";
let liveCommentId = "";
let liveDefinitionId = "";

const withFlag = (cookie: string) => `${cookie}; ${FLAG_ON}`;

const idOf = (result: Awaited<ReturnType<typeof h.fate>>, what: string): string => {
	if (!result.ok) throw new Error(`seed ${what} failed: ${result.error.code}`);
	return (result.data as Node).id;
};

const submitPost = (cookie: string, slug: string) =>
	h.fate(
		{
			kind: "mutation",
			name: "post.submit",
			input: {title: `${NS} ${slug}`, url: `https://${HOST}/${slug}`, tags: [{kind: "soru"}]},
			select: ["id"],
		},
		{cookie},
	);

const addComment = (cookie: string) =>
	h.fate(
		{
			kind: "mutation",
			name: "comment.add",
			input: {postId: livePostId, body: `${NS} doğrulanmamış yorum — yeterince uzun`},
			select: ["id"],
		},
		{cookie},
	);

const addDefinition = (cookie: string) =>
	h.fate(
		{
			kind: "mutation",
			name: "definition.add",
			input: {termSlug: TERM_SLUG, termTitle: TERM_SLUG, body: `${NS} doğrulanmamış tanım`},
			select: ["id"],
		},
		{cookie},
	);

/** A real email sign-in, returning the session cookie it set. */
const signIn = async (email: string): Promise<{status: number; cookie: string}> => {
	const res = await h.json("/api/auth/sign-in/email", {email, password: PASSWORD});
	const setCookie = res.headers.get("set-cookie") ?? "";
	const cookie = setCookie
		.split(/,(?=[^;]+=)/)
		.map((part) => part.split(";")[0]!.trim())
		.filter((kv) => kv.includes("="))
		.join("; ");
	return {status: res.status, cookie};
};

beforeAll(async () => {
	yazar = await h.signUpYazar(`${NS}-yazar@test.local`, PASSWORD, "yazar");
	unverified = await h.signUp(UNVERIFIED_EMAIL, PASSWORD, "çaylak");

	// SETUP DISCRIMINATOR: a fresh sign-up must start unverified, or every denial below is vacuous.
	expect(
		await h.countD1(
			`SELECT id FROM "user" WHERE id = ? AND (email_verified = 0 OR email_verified IS NULL)`,
			[unverified.userId],
		),
	).toBe(1);

	livePostId = idOf(await submitPost(yazar.cookie, "live"), "the yazar post");
	liveCommentId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId: livePostId, body: `${NS} yazar yorumu — yeterince uzun`},
				select: ["id"],
			},
			{cookie: yazar.cookie},
		),
		"the yazar comment",
	);
	liveDefinitionId = idOf(
		await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug: TERM_SLUG, termTitle: TERM_SLUG, body: `${NS} yazar tanımı`},
				select: ["id"],
			},
			{cookie: yazar.cookie},
		),
		"the yazar definition",
	);
});

describe("ADR 0434 — an unverified çaylak with the gate on", () => {
	it("is refused post, comment and definition writes with EMAIL_UNVERIFIED", async () => {
		const cookie = withFlag(unverified.cookie);
		for (const result of [
			await submitPost(cookie, "denied"),
			await addComment(cookie),
			await addDefinition(cookie),
		]) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("EMAIL_UNVERIFIED");
		}
	});

	it("can still sign in", async () => {
		const {status, cookie} = await signIn(UNVERIFIED_EMAIL);
		expect(status).toBe(200);
		expect(cookie).not.toBe("");
	});

	it("can still read posts, comments and definitions", async () => {
		const cookie = withFlag(unverified.cookie);

		const feed = await h.fate(
			{kind: "list", name: "posts", args: {sort: "new", host: HOST}, select: ["id"]},
			{cookie},
		);
		expect(feed.ok).toBe(true);
		if (feed.ok) {
			const ids = (feed.data as Connection<Node>).items.map((edge) => edge.node.id);
			expect(ids).toContain(livePostId);
		}

		const thread = await h.fate(
			{
				kind: "query",
				name: "post",
				args: {idOrSlug: livePostId},
				select: ["id", "comments.id", "comments.body"],
			},
			{cookie},
		);
		expect(thread.ok).toBe(true);
		if (thread.ok) {
			const data = thread.data as {id: string; comments?: Connection<Node>} | null;
			expect(data?.id).toBe(livePostId);
			expect((data?.comments?.items ?? []).map((edge) => edge.node.id)).toContain(liveCommentId);
		}

		const term = await h.fate(
			{
				kind: "query",
				name: "term",
				args: {slug: TERM_SLUG},
				select: ["id", "slug", "definitions.id", "definitions.body"],
			},
			{cookie},
		);
		expect(term.ok).toBe(true);
		if (term.ok) {
			const data = term.data as {definitions?: Connection<Node>} | null;
			expect((data?.definitions?.items ?? []).map((edge) => edge.node.id)).toContain(
				liveDefinitionId,
			);
		}
	});

	it("writes on the same session once the address is verified — the read is fresh", async () => {
		const changes = await h.execD1(`UPDATE "user" SET email_verified = 1 WHERE id = ?`, [
			unverified.userId,
		]);
		expect(changes).toBe(1);

		const result = await addComment(withFlag(unverified.cookie));
		expect(result.ok).toBe(true);
	});
});
