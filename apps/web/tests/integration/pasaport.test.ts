/**
 * pasaport identity + profile — black-box against the deployed worker `/fate`
 * route (ADR 0026–0031).
 *
 * Ports the observable surface of four pre-alchemy suites that drove the
 * resolvers / `Pasaport` service directly inside workerd:
 *   - `fate-pasaport-mutations.test.ts` — `user.setUsername` write + re-resolve,
 *     authenticated `me`, and the username wire-error codes (`TOO_SHORT`,
 *     `INVALID_FORMAT`, `TAKEN`, `ALREADY_SET`, `UNAUTHORIZED`).
 *   - `fate-pasaport-read.test.ts` — `profile(username)` identity + live counters,
 *     null for unknown, the mixed discriminant contributions feed, keyset
 *     pagination.
 *   - `pasaport-username.test.ts` — username validation / uniqueness / immutability
 *     (re-expressed as the wire codes).
 *   - `profile.test.ts` — profile aggregates (1/1/1) + the interleaved
 *     contributions feed + disjoint cursor pages.
 *
 * Everything is observed over HTTP. Identity comes from the session
 * (`h.signUp` → cookie). A profile's contributions are seeded by setting a
 * username on the user, then creating one `definition.add` + one `post.submit`
 * + one `comment.add` under that cookie. Validation is asserted by the wire
 * CODE (`error.code`), never the Turkish message text — the message may carry
 * TR text but the stable contract is the code.
 *
 * D1 is shared (one deploy) — every email/username/slug is uniquely prefixed
 * (`pasa-${STAMP}-…`); usernames stay within the 3–30 lowercase `[a-z0-9-]` rule.
 *
 * not portable black-box: `pasaport-username.test.ts` `user_profile` row
 * read-backs and the Turkish validation message regexes (`/en az 3/`,
 * `/küçük harf/`, `/kullanımda/`, `/zaten/`) — re-expressed as the stable
 * wire codes.
 * not portable black-box: `profile.test.ts` direct `user_profile` seed +
 * `definition_view` / `post_summary` / `comment_view` row-landing `waitFor`s
 * (writes are synchronous over `/fate`; just re-resolve) and the `createdAt`
 * timestamp ordering probe (the wire feed exposes a `<sec>:<id>` cursor, not a
 * `Date`) — re-expressed via the keyset cursor order + id-union assertions.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {integrationStack} from "./_integration.ts";

const h = integrationStack(import.meta.url);

const STAMP = Date.now().toString(36);
let counter = 0;
/** A unique 3–30 char lowercase `[a-z0-9-]` username for this suite. */
const uname = (label: string) => `pasa-${STAMP}-${label}-${counter++}`;

interface UserNode {
	__typename: string;
	id: string;
	username: string | null;
	email: string;
	name: string | null;
}
interface ProfileNode {
	userId: string;
	username: string;
	displayName: string | null;
	totalKarma: number;
	definitionCount: number;
	postCount: number;
	commentCount: number;
}
interface ContributionNode {
	kind: "definition" | "post" | "comment";
	id: string;
	score: number;
	termSlug: string | null;
	termTitle: string | null;
	title: string | null;
	slug: string | null;
	postId: string | null;
	postTitle: string | null;
}
interface Contributions {
	items: Array<{cursor: string; node: ContributionNode}>;
	pagination: {hasNext: boolean; hasPrevious: boolean; nextCursor?: string};
}

const PROFILE_SELECT = [
	"userId",
	"username",
	"displayName",
	"totalKarma",
	"definitionCount",
	"postCount",
	"commentCount",
];
const CONTRIB_SELECT = [
	"contributions.kind",
	"contributions.id",
	"contributions.score",
	"contributions.termSlug",
	"contributions.title",
	"contributions.postId",
];

/** Set a username on a user (under their cookie); assert success. */
async function setUsername(cookie: string, value: string): Promise<UserNode> {
	const result = await h.fate(
		{
			kind: "mutation",
			name: "user.setUsername",
			input: {value},
			select: ["id", "username", "email", "name"],
		},
		{cookie},
	);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`setUsername failed: ${JSON.stringify(result)}`);
	return result.data as UserNode;
}

describe("pasaport — user.setUsername / me", () => {
	it("user.setUsername writes and returns the re-resolved User; me reflects it", async () => {
		const user = await h.signUp(`pasa-${STAMP}-setname@test.local`, "hunter2hunter2", "Set Name");
		const value = uname("setname");

		const out = await setUsername(user.cookie, value);
		expect(out.__typename).toBe("User");
		expect(out.id).toBe(user.userId);
		expect(out.username).toBe(value);
		expect(out.email).toBe(`pasa-${STAMP}-setname@test.local`);
		expect(out.name).toBe("Set Name");

		// `me` (with cookie) now reflects the freshly-set username.
		const me = await h.fate(
			{kind: "query", name: "me", select: ["id", "email", "username"]},
			{cookie: user.cookie},
		);
		expect(me.ok).toBe(true);
		if (!me.ok) return;
		const meData = me.data as UserNode;
		expect(meData.id).toBe(user.userId);
		expect(meData.username).toBe(value);
	});

	it("a too-short username surfaces TOO_SHORT", async () => {
		const user = await h.signUp(`pasa-${STAMP}-short@test.local`, "hunter2hunter2", "Too Short");
		const result = await h.fate(
			{kind: "mutation", name: "user.setUsername", input: {value: "ab"}, select: ["id"]},
			{cookie: user.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TOO_SHORT");
	});

	it("an illegal-format username surfaces INVALID_FORMAT", async () => {
		const user = await h.signUp(`pasa-${STAMP}-fmt@test.local`, "hunter2hunter2", "Bad Format");
		const result = await h.fate(
			{
				kind: "mutation",
				name: "user.setUsername",
				input: {value: "Bad_Name!"},
				select: ["id"],
			},
			{cookie: user.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_FORMAT");
	});

	it("a taken username surfaces TAKEN", async () => {
		const value = uname("taken");
		const owner = await h.signUp(`pasa-${STAMP}-owner@test.local`, "hunter2hunter2", "Owner");
		await setUsername(owner.cookie, value);

		const other = await h.signUp(`pasa-${STAMP}-other@test.local`, "hunter2hunter2", "Other");
		const result = await h.fate(
			{kind: "mutation", name: "user.setUsername", input: {value}, select: ["id"]},
			{cookie: other.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TAKEN");
	});

	it("setting a username twice surfaces ALREADY_SET", async () => {
		const user = await h.signUp(`pasa-${STAMP}-twice@test.local`, "hunter2hunter2", "Twice");
		await setUsername(user.cookie, uname("twice"));

		const result = await h.fate(
			{
				kind: "mutation",
				name: "user.setUsername",
				input: {value: uname("twice-again")},
				select: ["id"],
			},
			{cookie: user.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("ALREADY_SET");
	});

	it("anonymous setUsername surfaces UNAUTHORIZED", async () => {
		const result = await h.fate({
			kind: "mutation",
			name: "user.setUsername",
			input: {value: uname("anon")},
			select: ["id"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});

	it("anonymous me surfaces UNAUTHORIZED", async () => {
		const result = await h.fate({kind: "query", name: "me", select: ["id"]});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNAUTHORIZED");
	});
});

describe("pasaport — profile reads", () => {
	const username = uname("profile");
	let userId = "";

	beforeAll(async () => {
		const user = await h.signUp(
			`pasa-${STAMP}-profile@test.local`,
			"hunter2hunter2",
			"Fate Profile",
		);
		userId = user.userId;
		await setUsername(user.cookie, username);

		// Seed one of each contribution kind so the discriminant feed is mixed.
		const def = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug: `pasa-${STAMP}-profile-term`,
					termTitle: "Profile Term",
					body: "a seeded definition for the profile feed",
				},
				select: ["id"],
			},
			{cookie: user.cookie},
		);
		expect(def.ok).toBe(true);

		const post = await h.fate(
			{
				kind: "mutation",
				name: "post.submit",
				input: {
					title: `pasa-${STAMP} profile post`,
					url: "https://example.com/pasa-profile",
					body: "a seeded post",
					tags: [{kind: "tartışma"}],
				},
				select: ["id"],
			},
			{cookie: user.cookie},
		);
		expect(post.ok).toBe(true);
		if (!post.ok) throw new Error("seed post failed");
		const postId = (post.data as {id: string}).id;

		const comment = await h.fate(
			{
				kind: "mutation",
				name: "comment.add",
				input: {postId, body: "a seeded comment"},
				select: ["id"],
			},
			{cookie: user.cookie},
		);
		expect(comment.ok).toBe(true);
	});

	it("profile(username) returns identity + live-aggregated counters (1/1/1)", async () => {
		const result = await h.fate({
			kind: "query",
			name: "profile",
			args: {username},
			select: PROFILE_SELECT,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as ProfileNode;
		expect(data.userId).toBe(userId);
		expect(data.username).toBe(username);
		expect(data.displayName).toBe("Fate Profile");
		expect(data.definitionCount).toBe(1);
		expect(data.postCount).toBe(1);
		expect(data.commentCount).toBe(1);
	});

	it("profile(username) returns null for an unknown username", async () => {
		const result = await h.fate({
			kind: "query",
			name: "profile",
			args: {username: `no-such-user-${STAMP}`},
			select: ["userId"],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBeNull();
	});

	it("Profile.contributions is a mixed discriminant feed (kind per node)", async () => {
		const result = await h.fate({
			kind: "query",
			name: "profile",
			args: {username, contributions: {first: 10}},
			select: ["username", ...CONTRIB_SELECT],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const data = result.data as {contributions: Contributions};
		expect(data.contributions.items.length).toBe(3);
		const kinds = data.contributions.items.map((e) => e.node.kind).sort();
		expect(kinds).toEqual(["comment", "definition", "post"]);
		// Cursor is the `<epochSeconds>:<id>` keyset key.
		for (const e of data.contributions.items) {
			expect(e.cursor).toMatch(/^\d+:.+$/);
		}
		expect(data.contributions.pagination.hasNext).toBe(false);
		expect(data.contributions.pagination.hasPrevious).toBe(false);
	});

	it("totalKarma moves 0 → 1 → 0 as a vote on the author's definition is cast then retracted", async () => {
		// Restores the old 0→1→0 karma read-back the pre-alchemy suites had: a vote
		// on the author's content bumps the author's `user_profile.total_karma`
		// atomically (see `pasaport/karma.ts` + `Vote.cast`); retracting reverses it.
		//
		// Real-D1 POSITIVE batch-atomicity proof: one cast lands the vote-table write
		// (score), the `user_vote` mirror (myVote), the score-cache update, and the
		// karma bump as one unit. The NEGATIVE half (mid-batch rollback / no-partial-
		// write) has no fate-reachable fault — every `Vote.cast` batch statement is
		// collision-tolerant by construction — so it stays the generic `db.batch`
		// property in `db/Drizzle.test.ts`, tracked for real-D1 migration under #582
		// (see #614; #581 AC3).
		const authorUsername = uname("karma");
		const author = await h.signUp(
			`pasa-${STAMP}-karma@test.local`,
			"hunter2hunter2",
			"Karma Author",
		);
		await setUsername(author.cookie, authorUsername);

		// The author writes a definition; a distinct voter will up-vote it.
		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug: `pasa-${STAMP}-karma-term`,
					termTitle: "Karma Term",
					body: "a definition whose votes feed the author's karma",
				},
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

		// Baseline: a freshly-seeded author has zero karma.
		expect(await karmaOf()).toBe(0);

		const voter = await h.signUp(`pasa-${STAMP}-voter@test.local`, "hunter2hunter2", "Voter");
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
		// The vote bumped the author's karma to 1.
		expect(await karmaOf()).toBe(1);

		const retract = await h.fate(
			{
				kind: "mutation",
				name: "definition.retractVote",
				input: {id: definitionId},
				select: ["score"],
			},
			{cookie: voter.cookie},
		);
		expect(retract.ok).toBe(true);
		// Retracting returns the author's karma to 0.
		expect(await karmaOf()).toBe(0);
	});

	it("Profile.contributions paginates by keyset with no skips/dupes, discriminant preserved", async () => {
		// Page 1: first 2 in (createdAt desc, id desc) order.
		const page1 = await h.fate({
			kind: "query",
			name: "profile",
			args: {username, contributions: {first: 2}},
			select: ["username", "contributions.kind", "contributions.id"],
		});
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		const d1 = page1.data as {contributions: Contributions};
		expect(d1.contributions.items.length).toBe(2);
		expect(d1.contributions.pagination.hasNext).toBe(true);
		const cursor = d1.contributions.pagination.nextCursor;
		expect(cursor).toBeDefined();
		if (cursor === undefined) return;
		// Cursor is the last node's keyset key (`<sec>:<id>`, ends with its id).
		const lastNodeId = d1.contributions.items[1]!.node.id;
		expect(cursor.endsWith(lastNodeId)).toBe(true);

		// Page 2: after the page-1 cursor → the final contribution.
		const page2 = await h.fate({
			kind: "query",
			name: "profile",
			args: {username, contributions: {first: 2, after: cursor}},
			select: ["username", "contributions.kind", "contributions.id"],
		});
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		const d2 = page2.data as {contributions: Contributions};
		expect(d2.contributions.items.length).toBe(1);
		expect(d2.contributions.pagination.hasNext).toBe(false);

		// No skips/dupes: union of all page ids is exactly the 3 seeded; every
		// node still carries a valid discriminant `kind`.
		const allNodes = [...d1.contributions.items, ...d2.contributions.items].map((e) => e.node);
		expect(new Set(allNodes.map((n) => n.id)).size).toBe(3);
		expect(new Set(allNodes.map((n) => n.kind))).toEqual(
			new Set(["comment", "definition", "post"]),
		);
	});
});
