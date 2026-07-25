import {assert, describe, it} from "@effect/vitest";
import {type LocalPresence, livenessByComment, type PidState} from "../epic-lock/claim-presence.ts";
import type {ClaimComment} from "../epic-lock/claim-resolution.ts";
import {
	type AuditPolicy,
	auditLane,
	auditReport,
	DEFAULT_MIN_AGE_HOURS,
	type LaneInput,
	STAMPING_CUTOFF,
} from "./claim-audit.ts";
import {claimIsMine} from "./claim-is-mine.ts";
import {releasePlan} from "./claim-release.ts";

const LEGACY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LIVE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
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

const policy = (over?: Partial<AuditPolicy>): AuditPolicy => ({
	cutoff: STAMPING_CUTOFF,
	minAgeMs: DEFAULT_MIN_AGE_HOURS * 60 * 60 * 1000,
	now: "2026-07-28T00:00:00Z",
	...over,
});

const lane = (issue: number, comments: ReadonlyArray<ClaimComment>): LaneInput => ({
	issue,
	comments,
	authorizedAuthors: AUTHORIZED,
	liveness: livenessByComment(comments, local("unprobeable")),
});

describe("auditLane — naming the pre-stamping population (#4031)", () => {
	it("flags an unstamped pre-cutoff holder that shadows a later live claimant", () => {
		// The #3718 shape: a 2026-07-20 unstamped marker outranking the session that opened the PR.
		const legacy = claim({id: 5019741445, session: LEGACY, at: "2026-07-20T10:00:00Z"});
		const live = claim({
			id: 5077675710,
			session: LIVE,
			at: "2026-07-25T09:00:00Z",
			presence: `${HOST}/4242`,
		});

		const audited = auditLane(lane(3718, [legacy, live]), policy());

		assert.ok(audited !== null);
		assert.strictEqual(audited.disposition, "retire");
		assert.strictEqual(audited.reason, "pre-stamping");
		assert.strictEqual(audited.owner.session, LEGACY);
		assert.deepStrictEqual(
			audited.shadowed.map((claimed) => claimed.session),
			[LIVE],
		);
	});

	it("ignores a lane whose holder carries a presence stamp — supersession already owns it", () => {
		const stamped = claim({
			id: 10,
			session: LEGACY,
			at: "2026-07-01T00:00:00Z",
			presence: `${HOST}/4242`,
		});

		assert.strictEqual(auditLane(lane(1, [stamped]), policy()), null);
	});

	it("ignores a lane no authorized claim holds", () => {
		const forged = claim({id: 10, session: LEGACY, at: "2026-07-01T00:00:00Z", login: "outsider"});

		assert.strictEqual(auditLane(lane(1, [forged]), policy()), null);
		assert.strictEqual(auditLane(lane(2, []), policy()), null);
	});
});

describe("auditLane — every doubt holds the claim", () => {
	it("holds an unstamped marker written after the cutoff (a degraded writer, not a legacy marker)", () => {
		const degraded = claim({id: 10, session: LEGACY, at: "2026-07-26T00:00:00Z"});

		const audited = auditLane(lane(1, [degraded]), policy());

		assert.strictEqual(audited?.disposition, "hold");
		assert.strictEqual(audited?.reason, "post-cutoff");
	});

	it("holds a pre-cutoff marker younger than the safety margin — its session may still run", () => {
		const fresh = claim({id: 10, session: LEGACY, at: "2026-07-25T20:00:00Z"});

		const audited = auditLane(lane(1, [fresh]), policy({now: "2026-07-25T22:00:00Z"}));

		assert.strictEqual(audited?.disposition, "hold");
		assert.strictEqual(audited?.reason, "within-safety-margin");
	});

	it("holds when the same session also left a stamped marker a token-scoped release would take", () => {
		const legacy = claim({id: 10, session: LEGACY, at: "2026-07-20T10:00:00Z"});
		const restamped = claim({
			id: 11,
			session: LEGACY,
			at: "2026-07-26T10:00:00Z",
			presence: `${HOST}/4242`,
		});

		const audited = auditLane(lane(1, [legacy, restamped]), policy());

		assert.strictEqual(audited?.disposition, "hold");
		assert.strictEqual(audited?.reason, "session-restamped");
	});

	it("holds a marker whose timestamp will not parse", () => {
		const malformed = claim({id: 10, session: LEGACY, at: "not-a-date"});

		const audited = auditLane(lane(1, [malformed]), policy());

		assert.strictEqual(audited?.disposition, "hold");
		assert.strictEqual(audited?.reason, "indeterminate-age");
	});

	it("never retires a stamped claim, whatever its age — the fail-closed rule is untouched", () => {
		const ancient = claim({
			id: 10,
			session: LEGACY,
			at: "2020-01-01T00:00:00Z",
			presence: `${HOST}/4242`,
		});

		assert.strictEqual(auditLane(lane(1, [ancient]), policy({now: "2030-01-01T00:00:00Z"})), null);
	});
});

describe("auditReport — the blast radius, and what retirement unlocks", () => {
	it("separates the retirable subset from the lanes it must leave alone", () => {
		const report = auditReport(
			[
				lane(1, [claim({id: 10, session: LEGACY, at: "2026-07-20T10:00:00Z"})]),
				lane(2, [claim({id: 20, session: LEGACY, at: "2026-07-26T10:00:00Z"})]),
				lane(3, [
					claim({id: 30, session: LEGACY, at: "2026-07-01T00:00:00Z", presence: `${HOST}/1`}),
				]),
			],
			policy(),
		);

		assert.strictEqual(report.scanned, 3);
		assert.deepStrictEqual(
			report.locked.map((held) => held.issue),
			[1, 2],
		);
		assert.deepStrictEqual(
			report.retirable.map((held) => held.issue),
			[1],
		);
	});

	it("retiring through `claim release` hands the lane to the live claimant", () => {
		const legacy = claim({id: 5019741445, session: LEGACY, at: "2026-07-20T10:00:00Z"});
		const live = claim({id: 5077675710, session: LIVE, at: "2026-07-25T09:00:00Z"});
		const before = [legacy, live];

		const audited = auditLane(lane(3718, before), policy());
		assert.ok(audited !== null);
		assert.strictEqual(audited.disposition, "retire");

		// Retirement is `claim release` under the marker's own token — the one retraction
		// mechanism (#3780), not a second one. It takes the legacy marker and nothing else.
		const plan = releasePlan(before, audited.owner.session);
		assert.deepStrictEqual(plan.retract, [5019741445]);
		assert.deepStrictEqual(
			plan.kept.map((kept) => kept.session),
			[LIVE],
		);

		const after = before.filter((comment) => !plan.retract.includes(comment.id));
		const verdict = claimIsMine({
			comments: after,
			authorizedAuthors: AUTHORIZED,
			sessionId: LIVE,
			liveness: livenessByComment(after, local("unprobeable")),
		});
		assert.strictEqual(verdict.mine, true);
		assert.strictEqual(verdict.winner?.id, 5077675710);
	});
});
