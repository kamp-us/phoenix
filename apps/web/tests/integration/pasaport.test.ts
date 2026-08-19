/**
 * pasaport identity + profile — black-box against the deployed worker `/fate`
 * route (ADR 0026–0031).
 *
 * Validation is asserted by the wire CODE (`error.code`), never the Turkish message text — the
 * message may carry TR text but the stable contract is the code.
 *
 * Runs on the run-scoped SHARED stage (ADR 0104 step 7), so one D1 is shared across every
 * migrated file: every email/username/slug is `NS`-prefixed (this file's deterministic
 * `nsToken`), usernames stay within the 3–30 lowercase `[a-z0-9-]` rule, and every assertion
 * scopes to its own rows.
 */
import {beforeAll, describe, expect, it} from "vitest";
import {sharedStack} from "./_integration.ts";
import {nsToken} from "./_stage-name.ts";

const h = sharedStack();

const NS = nsToken(import.meta.url);
let counter = 0;
/** A unique 3–30 char lowercase `[a-z0-9-]` username for this suite. */
const uname = (label: string) => `${NS}-${label}-${counter++}`;

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
		const user = await h.signUp(`${NS}-setname@test.local`, "hunter2hunter2", "Set Name");
		const value = uname("setname");

		const out = await setUsername(user.cookie, value);
		expect(out.__typename).toBe("User");
		expect(out.id).toBe(user.userId);
		expect(out.username).toBe(value);
		expect(out.email).toBe(`${NS}-setname@test.local`);
		expect(out.name).toBe("Set Name");

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

	// TOO_SHORT / TOO_LONG / INVALID_FORMAT need no DB, so they live in
	// `worker/features/pasaport/username-validation.unit.test.ts` (ADR 0082).

	it("a taken username surfaces TAKEN", async () => {
		const value = uname("taken");
		const owner = await h.signUp(`${NS}-owner@test.local`, "hunter2hunter2", "Owner");
		await setUsername(owner.cookie, value);

		const other = await h.signUp(`${NS}-other@test.local`, "hunter2hunter2", "Other");
		const result = await h.fate(
			{kind: "mutation", name: "user.setUsername", input: {value}, select: ["id"]},
			{cookie: other.cookie},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TAKEN");
	});

	it("setting a username twice surfaces ALREADY_SET", async () => {
		const user = await h.signUp(`${NS}-twice@test.local`, "hunter2hunter2", "Twice");
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
		// An established member: the counters/feed below are read ANONYMOUSLY, and a
		// çaylak's contributions are sandbox-masked from every reader but the author/mod.
		const user = await h.signUpYazar(`${NS}-profile@test.local`, "hunter2hunter2", "Fate Profile");
		userId = user.userId;
		await setUsername(user.cookie, username);

		// Seed one of each contribution kind so the discriminant feed is mixed.
		const def = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug: `${NS}-profile-term`,
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
					title: `${NS} profile post`,
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
			args: {username: `no-such-user-${NS}`},
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
		// The POSITIVE half of `Vote.cast`'s batch atomicity: one cast lands the vote row, the
		// `user_vote` mirror, the score cache and the karma bump as one unit. The NEGATIVE half
		// (mid-batch rollback) has no fate-reachable fault — every batch statement is
		// collision-tolerant by construction — so it stays a `db/Drizzle.test.ts` property (#582).
		const authorUsername = uname("karma");
		const author = await h.signUpYazar(`${NS}-karma@test.local`, "hunter2hunter2", "Karma Author");
		await setUsername(author.cookie, authorUsername);

		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug: `${NS}-karma-term`,
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

		expect(await karmaOf()).toBe(0);

		// Promoted to yazar so it clears the #1810 "earn to vote" gate (a fresh çaylak is
		// rejected at cast) and its up-vote lands to credit the author's karma.
		const voter = await h.signUp(`${NS}-voter@test.local`, "hunter2hunter2", "Voter");
		await h.promoteToYazar(voter.userId);
		const vote = await h.fate(
			{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
			{cookie: voter.cookie},
		);
		expect(vote.ok).toBe(true);
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
		expect(await karmaOf()).toBe(0);
	});

	it("concurrent duplicate casts bump total_karma exactly once — no double-bump (#2552)", async () => {
		// The double-bump race: `Vote.castImpl` probes idempotency OUTSIDE the atomic batch, so
		// two concurrent identical casts both see `alreadyCast=false` and both run the batch. The
		// vote row (`onConflictDoNothing`) and the `COUNT(*)` score stay correct, but before #2552
		// the unconditional karma UPDATE bumped `total_karma` TWICE (and appended a second ledger
		// row). The fix gates the karma bump + its ledger row on the vote row's PRE-mutation
		// presence, so the duplicate is a karma no-op. This is the real-D1 reproduction: fire the
		// two casts truly concurrently and assert the author gains exactly one karma — a value that
		// is invariant under the fix whether or not the probes actually raced, and was `2` (flaky)
		// before it. The retract direction is symmetric (a single net -1, never -2).
		const authorUsername = uname("race");
		const author = await h.signUpYazar(`${NS}-race@test.local`, "hunter2hunter2", "Race Author");
		await setUsername(author.cookie, authorUsername);

		const added = await h.fate(
			{
				kind: "mutation",
				name: "definition.add",
				input: {
					termSlug: `${NS}-race-term`,
					termTitle: "Race Term",
					body: "a definition whose concurrent votes must not double-credit karma",
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

		expect(await karmaOf()).toBe(0);

		const voter = await h.signUp(`${NS}-race-voter@test.local`, "hunter2hunter2", "Race Voter");
		await h.promoteToYazar(voter.userId);
		const castOnce = () =>
			h.fate(
				{kind: "mutation", name: "definition.vote", input: {id: definitionId}, select: ["score"]},
				{cookie: voter.cookie},
			);
		const casts = await Promise.all([castOnce(), castOnce()]);
		for (const c of casts) expect(c.ok).toBe(true);
		expect(await karmaOf()).toBe(1);

		const retractOnce = () =>
			h.fate(
				{
					kind: "mutation",
					name: "definition.retractVote",
					input: {id: definitionId},
					select: ["score"],
				},
				{cookie: voter.cookie},
			);
		const retracts = await Promise.all([retractOnce(), retractOnce()]);
		for (const r of retracts) expect(r.ok).toBe(true);
		expect(await karmaOf()).toBe(0);
	});

	it("Profile.contributions paginates by keyset with no skips/dupes, discriminant preserved", async () => {
		// The feed's keyset order is (createdAt desc, id desc).
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

		const allNodes = [...d1.contributions.items, ...d2.contributions.items].map((e) => e.node);
		expect(new Set(allNodes.map((n) => n.id)).size).toBe(3);
		expect(new Set(allNodes.map((n) => n.kind))).toEqual(
			new Set(["comment", "definition", "post"]),
		);
	});
});
