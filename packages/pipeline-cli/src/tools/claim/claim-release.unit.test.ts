import {assert, describe, it} from "@effect/vitest";
import {type LocalPresence, livenessByComment, type PidState} from "../epic-lock/claim-presence.ts";
import type {ClaimComment} from "../epic-lock/claim-resolution.ts";
import {claimIsMine} from "./claim-is-mine.ts";
import {releasePlan} from "./claim-release.ts";
import {claimStatus} from "./claim-status.ts";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NEWCOMER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HOST = "abc123def456";
const AUTHORIZED = ["usirin"];

const claim = (over: {
	readonly id: number;
	readonly session: string;
	readonly at: string;
	readonly presence?: string;
	readonly login?: string;
}): ClaimComment => ({
	id: over.id,
	author: over.login ?? "usirin",
	createdAt: over.at,
	body: `claim: ${over.session} · ${over.at}${over.presence ? ` · presence ${over.presence}` : ""}`,
});

const local = (probe: PidState): LocalPresence => ({host: HOST, probePid: () => probe});

/** The resolution a later dispatch performs: is this lane mine, given who still holds a marker? */
const resolveFor = (
	comments: ReadonlyArray<ClaimComment>,
	session: string,
	presence: LocalPresence,
) =>
	claimIsMine({
		comments,
		authorizedAuthors: AUTHORIZED,
		sessionId: session,
		liveness: livenessByComment(comments, presence),
	});

describe("release — a completed run gives its own claim up (#3780)", () => {
	it("retracts our own marker and frees the lane for the next dispatch", () => {
		const held = claim({id: 100, session: OWNER, at: "2026-07-25T06:31:38Z"});

		// Before release the lane is owned: a re-dispatch under a fresh session reads `lost` — the
		// observed stall (a repair on #3983 refused by a claim whose run had long finished).
		const before = resolveFor([held], NEWCOMER, local("unprobeable"));
		assert.strictEqual(before.mine, false);
		assert.strictEqual(before.reason, "lost");

		// The owner releases: exactly its own marker, nothing else.
		const plan = releasePlan([held], OWNER);
		assert.deepStrictEqual(plan.retract, [100]);
		assert.deepStrictEqual(plan.kept, []);

		// After release the lane resolves as claimable, and the re-dispatch's own claim wins.
		const reclaimed = claim({id: 200, session: NEWCOMER, at: "2026-07-25T09:00:00Z"});
		assert.strictEqual(resolveFor([], NEWCOMER, local("unprobeable")).reason, "no-winner");
		assert.strictEqual(resolveFor([reclaimed], NEWCOMER, local("unprobeable")).mine, true);
	});

	it("is idempotent — releasing an already-released claim retracts nothing and does not fail", () => {
		assert.deepStrictEqual(releasePlan([], OWNER), {retract: [], kept: []});
	});

	it("retracts every marker our session posted across retried acquires", () => {
		const first = claim({id: 100, session: OWNER, at: "2026-07-25T06:31:38Z"});
		const second = claim({id: 140, session: OWNER, at: "2026-07-25T06:33:00Z"});
		assert.deepStrictEqual(releasePlan([first, second], OWNER).retract, [100, 140]);
	});
});

describe("release never evicts — a live claim stands even when the session id differs", () => {
	it("a genuinely-alive claimant is NOT reclaimable, and its marker is not retractable by another token", () => {
		// The marker is presence-stamped and its pid probes ALIVE — the sixth claim of the #3780
		// incident. The claiming session id differs from the running agent's current one, which is
		// exactly what a mid-run session-id rotation produces (#4045): identity mismatch is NOT
		// evidence the work is done, so nothing here may treat it as reclaimable.
		const live = claim({
			id: 100,
			session: OWNER,
			at: "2026-07-25T06:31:38Z",
			presence: `${HOST}/4242`,
		});

		const verdict = resolveFor([live], NEWCOMER, local("running"));
		assert.strictEqual(verdict.mine, false);
		assert.strictEqual(verdict.reason, "lost");
		assert.strictEqual(verdict.winner?.session, OWNER);
		assert.deepStrictEqual(verdict.superseded, []);

		// And a run holding a DIFFERENT token cannot retract it: release is keyed on the token the
		// caller owns, so it has no way to express "evict the other guy".
		const plan = releasePlan([live], NEWCOMER);
		assert.deepStrictEqual(plan.retract, []);
		assert.deepStrictEqual(
			plan.kept.map((c) => c.session),
			[OWNER],
		);
	});

	it("a later claim posted alongside a live one still loses — a newer marker never takes over", () => {
		const live = claim({
			id: 100,
			session: OWNER,
			at: "2026-07-25T06:31:38Z",
			presence: `${HOST}/4242`,
		});
		const newer = claim({id: 200, session: NEWCOMER, at: "2026-07-25T09:00:00Z"});
		const verdict = resolveFor([live, newer], NEWCOMER, local("running"));
		assert.strictEqual(verdict.mine, false);
		assert.strictEqual(verdict.winner?.session, OWNER);
	});
});

describe("fail-closed is unchanged — indeterminate liveness still means the claim stands", () => {
	it("an unstamped legacy claim is indeterminate: not superseded, not reclaimable, not releasable by another token", () => {
		const legacy = claim({id: 100, session: OWNER, at: "2026-07-20T07:48:00Z"});
		const presence = local("gone"); // even a probe that would prove death cannot apply: no stamp

		const verdict = resolveFor([legacy], NEWCOMER, presence);
		assert.strictEqual(verdict.mine, false);
		assert.strictEqual(verdict.reason, "lost");
		assert.deepStrictEqual(verdict.superseded, []);

		assert.deepStrictEqual(releasePlan([legacy], NEWCOMER).retract, []);

		// It surfaces as exactly what it is — an indeterminate owner a human may clear.
		const report = claimStatus({
			comments: [legacy],
			authorizedAuthors: AUTHORIZED,
			liveness: livenessByComment([legacy], presence),
		});
		assert.strictEqual(report.owner?.session, OWNER);
		assert.strictEqual(report.claims[0]?.liveness, "unknown");
		assert.strictEqual(report.claims[0]?.owner, true);
	});

	it("an unprobeable pid resolves unknown, never dead — the claim stands", () => {
		const stamped = claim({
			id: 100,
			session: OWNER,
			at: "2026-07-25T06:31:38Z",
			presence: `${HOST}/4242`,
		});
		const verdict = resolveFor([stamped], NEWCOMER, local("unprobeable"));
		assert.strictEqual(verdict.reason, "lost");
		assert.deepStrictEqual(verdict.superseded, []);
	});

	it("a claim stamped on another machine is unprobeable here, so it stands", () => {
		const elsewhere = claim({
			id: 100,
			session: OWNER,
			at: "2026-07-25T06:31:38Z",
			presence: "999999999999/4242",
		});
		const verdict = resolveFor([elsewhere], NEWCOMER, local("gone"));
		assert.strictEqual(verdict.reason, "lost");
		assert.deepStrictEqual(verdict.superseded, []);
	});

	it("release with no session id retracts nothing and keeps every claim (the command refuses loudly)", () => {
		const held = claim({id: 100, session: OWNER, at: "2026-07-25T06:31:38Z"});
		const plan = releasePlan([held], null);
		assert.deepStrictEqual(plan.retract, []);
		assert.strictEqual(plan.kept.length, 1);
	});
});

describe("claim status — the stale-claim inventory (read-only)", () => {
	it("reports every marker with its authorization, liveness, and the resolved owner", () => {
		const dead = claim({
			id: 100,
			session: OWNER,
			at: "2026-07-20T07:48:00Z",
			presence: `${HOST}/4242`,
		});
		const forged = claim({id: 120, session: NEWCOMER, at: "2026-07-21T00:00:00Z", login: "nobody"});
		const comments = [forged, dead];
		const report = claimStatus({
			comments,
			authorizedAuthors: AUTHORIZED,
			liveness: livenessByComment(comments, local("gone")),
		});

		assert.deepStrictEqual(
			report.claims.map((c) => [c.id, c.authorized, c.liveness, c.owner]),
			[
				[100, true, "dead", false],
				[120, false, "unknown", false],
			],
		);
		assert.strictEqual(report.owner, null);
		assert.deepStrictEqual(
			report.superseded.map((c) => c.id),
			[100],
		);
	});

	it("an unclaimed issue reports no owner — the lane is claimable", () => {
		const report = claimStatus({comments: [], authorizedAuthors: AUTHORIZED});
		assert.strictEqual(report.owner, null);
		assert.deepStrictEqual(report.claims, []);
	});
});
