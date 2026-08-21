/**
 * Account deletion = anonymize-to-`@[silinen]` (ADR 0097) — black-box against the
 * deployed worker `/fate` route on real remote D1 (ADR 0082 integration tier).
 *
 * Proves the end-to-end anonymize semantics a substituted seam can't reach.
 *
 * This file runs on the run-scoped SHARED stage (ADR 0104 step 7, #1027), so its one D1
 * is shared across every migrated file. Every email/slug/username this file seeds is `NS`-
 * prefixed (this file's deterministic `nsToken`) so its own rows can't collide. The one
 * shared-mutable row it touches is the `silinen` reserved sentinel profile, which multiple
 * files concurrently re-attribute deleted content to; the sentinel assertion is a lower-
 * bound `definitionCount >= 1` (re-attribution is an append, never an exact count), so it
 * holds under that concurrent inflation. `silinen` + the confirmation phrase are product
 * constants, not test data, and stay verbatim.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
let counter = 0;
const uname = (label: string) => `${NS}-${label}-${counter++}`;

const CONFIRMATION = "hesabımı kalıcı olarak sil";

interface DefNode {
	id: string;
	score: number;
	author: string;
	authorId: string;
}
type Connection<N> = {items: Array<{cursor: string; node: N}>};
const definitions = (data: unknown): DefNode[] =>
	(data as {definitions: Connection<DefNode>}).definitions.items.map((e) => e.node);

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

describe("account.delete — anonymize-to-@[silinen]", () => {
	it("re-attributes content to @[silinen] (kept Live, karma kept) and tears down the session", async () => {
		const authorUsername = uname("author");
		const author = await h.signUpYazar(`${NS}-author@test.local`, "hunter2hunter2", "Author");
		await setUsername(author.cookie, authorUsername);

		const termSlug = `${NS}-term`;
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {termSlug, termTitle: "Deletion Term", body: "content that survives its author"},
				select: ["id"],
			},
			{cookie: author.cookie},
		);
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		const definitionId = (added.data as {id: string}).id;

		const voter = await h.signUp(`${NS}-voter@test.local`, "hunter2hunter2", "Voter");
		await h.promoteToYazar(voter.userId);
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		if (!vote.ok) return;
		expect((vote.data as {score: number}).score).toBe(1);

		const wrong = await h.fate(
			{kind: "mutation", name: "account.delete", input: {confirmation: "sil"}, select: ["deleted"]},
			{cookie: author.cookie, retry: true},
		);
		expect(wrong.ok).toBe(false);
		// A rejected confirmation must tear nothing down: the session is still alive.
		const stillMe = await h.fate(
			{kind: "query", name: "me", select: ["id"]},
			{cookie: author.cookie},
		);
		expect(stillMe.ok).toBe(true);

		const del = await h.fate(
			{
				kind: "mutation",
				name: "account.delete",
				input: {confirmation: CONFIRMATION},
				select: ["deleted"],
			},
			{cookie: author.cookie, retry: true},
		);
		expect(del.ok).toBe(true);
		if (del.ok) expect((del.data as {deleted: boolean}).deleted).toBe(true);

		const goneMe = await h.fate(
			{kind: "query", name: "me", select: ["id"]},
			{cookie: author.cookie},
		);
		expect(goneMe.ok).toBe(false);
		if (!goneMe.ok) expect(goneMe.error.code).toBe("UNAUTHORIZED");

		// The definition stays LIVE on its term page (re-attribution, NOT removal),
		// now authored by @[silinen], with its score INTACT (votes/karma kept — the
		// up-vote that scored it is not reversed by the author's deletion).
		const term = await h.fate({
			kind: "query",
			name: "term",
			args: {slug: termSlug},
			select: ["definitions.id", "definitions.score", "definitions.author", "definitions.authorId"],
		});
		expect(term.ok).toBe(true);
		if (term.ok) {
			const def = definitions(term.data).find((d) => d.id === definitionId);
			expect(def).toBeDefined();
			if (def) {
				expect(def.authorId).toBe("silinen");
				expect(def.author).toBe("@[silinen]");
				expect(def.score).toBe(1);
			}
		}

		const silinenAfter = await h.fate({
			kind: "query",
			name: "profile",
			args: {username: "silinen"},
			select: ["username", "displayName", "definitionCount"],
		});
		expect(silinenAfter.ok).toBe(true);
		if (silinenAfter.ok) {
			const p = silinenAfter.data as {
				username: string;
				displayName: string | null;
				definitionCount: number;
			};
			expect(p.username).toBe("silinen");
			expect(p.displayName).toBe("@[silinen]");
			expect(p.definitionCount).toBeGreaterThanOrEqual(1);
		}
	});

	it("sweeps the leaving account's mutes, subscriptions and çaylak-visibility preference", async () => {
		const leaver = await h.signUp(`${NS}-leaver@test.local`, "hunter2hunter2", "Leaver");
		const peer = await h.signUp(`${NS}-peer@test.local`, "hunter2hunter2", "Peer");
		const bystander = await h.signUp(`${NS}-bystander@test.local`, "hunter2hunter2", "Bystander");
		const nowSeconds = Math.floor(Date.now() / 1000);

		// Seeded off the binding rather than through `mute.set` / `mecmua.subscribe` /
		// `caylakVisibility.optIn`: each of those is behind a flag or an earned-level gate,
		// none of which this test is about. Setup-only, the sanctioned `execD1` use.
		const mute = (muterId: string, mutedId: string) =>
			h.execD1("INSERT INTO user_mute (muter_id, muted_id, created_at) VALUES (?, ?, ?)", [
				muterId,
				mutedId,
				nowSeconds,
			]);
		const subscribe = (subscriberId: string, authorId: string) =>
			h.execD1(
				"INSERT INTO mecmua_subscription (author_id, subscriber_id, created_at) VALUES (?, ?, ?)",
				[authorId, subscriberId, nowSeconds],
			);

		await mute(leaver.userId, peer.userId);
		await mute(peer.userId, leaver.userId);
		await subscribe(leaver.userId, peer.userId);
		await subscribe(peer.userId, leaver.userId);
		await h.execD1("INSERT INTO caylak_visibility_preference (user_id, set_at) VALUES (?, ?)", [
			leaver.userId,
			nowSeconds,
		]);
		// The control edge: it touches neither side of the leaving account, so the sweep's
		// `where` must leave it standing.
		await mute(peer.userId, bystander.userId);

		const del = await h.fate(
			{
				kind: "mutation",
				name: "account.delete",
				input: {confirmation: CONFIRMATION},
				select: ["deleted"],
			},
			{cookie: leaver.cookie, retry: true},
		);
		expect(del.ok).toBe(true);

		// Both columns of each two-sided edge, so one predicate per table covers both
		// directions the account could sit in.
		const mutesLeft = await h.countD1(
			"SELECT 1 FROM user_mute WHERE muter_id = ? OR muted_id = ?",
			[leaver.userId, leaver.userId],
		);
		expect(mutesLeft).toBe(0);

		const subscriptionsLeft = await h.countD1(
			"SELECT 1 FROM mecmua_subscription WHERE subscriber_id = ? OR author_id = ?",
			[leaver.userId, leaver.userId],
		);
		expect(subscriptionsLeft).toBe(0);

		const preferencesLeft = await h.countD1(
			"SELECT 1 FROM caylak_visibility_preference WHERE user_id = ?",
			[leaver.userId],
		);
		expect(preferencesLeft).toBe(0);

		const controlLeft = await h.countD1(
			"SELECT 1 FROM user_mute WHERE muter_id = ? AND muted_id = ?",
			[peer.userId, bystander.userId],
		);
		expect(controlLeft).toBe(1);
	});

	it("the @[silinen] sentinel is seeded and resolvable as a real profile", async () => {
		const res = await h.fate({
			kind: "query",
			name: "profile",
			args: {username: "silinen"},
			select: ["username", "displayName"],
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			const p = res.data as {username: string; displayName: string | null};
			expect(p.username).toBe("silinen");
			expect(p.displayName).toBe("@[silinen]");
		}
	});

	it("nobody can register the reserved `silinen` username", async () => {
		const squatter = await h.signUp(`${NS}-squat@test.local`, "hunter2hunter2", "Squatter");
		const r = await h.fate(
			{kind: "mutation", name: "user.setUsername", input: {value: "silinen"}, select: ["id"]},
			{cookie: squatter.cookie},
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("INVALID_FORMAT");
	});
});
