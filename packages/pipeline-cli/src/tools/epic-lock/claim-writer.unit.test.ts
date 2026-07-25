import {assert, describe, it} from "@effect/vitest";
import {
	claimLiveness,
	type LocalPresence,
	livenessByComment,
	type PidState,
	parseClaimPresence,
} from "./claim-presence.ts";
import {CLAIM_RE, type ClaimComment, resolveWinner} from "./claim-resolution.ts";
import {stampedClaimBody} from "./claim-writer.ts";

const SID_DEAD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_LATER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTHORIZED = ["usirin"];

const local = (host: string, states: Record<number, PidState>): LocalPresence => ({
	host,
	probePid: (pid) => states[pid] ?? "unprobeable",
});

const comment = (id: number, createdAt: string, body: string): ClaimComment => ({
	id,
	author: "usirin",
	createdAt,
	body,
});

describe("stampedClaimBody — the single producer every claim writer composes through (#3987)", () => {
	it("stamps the presence it is handed, in the canonical marker grammar", () => {
		const body = stampedClaimBody(SID_DEAD, "2026-07-25T06:42:00Z", {host: "box-1", pid: 4242});
		assert.match(body, CLAIM_RE);
		assert.deepStrictEqual(parseClaimPresence(body), {host: "box-1", pid: 4242});
	});

	it("omits the stamp when no session presence resolved — a legacy-shaped marker, not a wrong one", () => {
		const body = stampedClaimBody(SID_DEAD, "2026-07-25T06:42:00Z", null);
		assert.match(body, CLAIM_RE);
		assert.strictEqual(parseClaimPresence(body), null);
	});
});

describe("a stamped marker is what makes supersession reachable at all (#3987 / #3751)", () => {
	// The end-to-end fact the writers' stamping buys: a marker COMPOSED BY A WRITER, read back by
	// the resolver, drops out of the tiebreak once its session process is provably gone — which is
	// what unsticks a lane whose claimant died. Before this, only `tracker claim` produced a marker
	// this could ever be true of; a claim from any other writer was permanently indeterminate.
	const deadClaim = comment(
		10,
		"2026-07-25T06:00:00Z",
		stampedClaimBody(SID_DEAD, "2026-07-25T06:00:00Z", {host: "box-1", pid: 4242}),
	);
	const laterClaim = comment(
		20,
		"2026-07-25T07:00:00Z",
		stampedClaimBody(SID_LATER, "2026-07-25T07:00:00Z", {host: "box-1", pid: 5150}),
	);
	const comments = [deadClaim, laterClaim];

	it("supersedes the dead claimant's earlier marker → the later live claim owns the lane", () => {
		const liveness = livenessByComment(comments, local("box-1", {4242: "gone", 5150: "running"}));
		assert.strictEqual(resolveWinner(comments, AUTHORIZED, liveness)?.session, SID_LATER);
	});

	it("leaves the earlier claim standing while its claimant is alive (doubt never evicts)", () => {
		const liveness = livenessByComment(
			comments,
			local("box-1", {4242: "running", 5150: "running"}),
		);
		assert.strictEqual(resolveWinner(comments, AUTHORIZED, liveness)?.session, SID_DEAD);
	});
});

describe("an unstamped legacy claim still STANDS — fail-closed is unchanged (#3987)", () => {
	// The load-bearing non-regression: making presence PRESENT is the fix; making an unstamped claim
	// supersedable would trade a stuck lane for live-claim eviction. An unstamped marker reads
	// indeterminate on every path — even one whose pid, coincidentally, is provably gone.
	const legacy = comment(
		10,
		"2026-07-25T06:00:00Z",
		stampedClaimBody(SID_DEAD, "2026-07-25T06:00:00Z", null),
	);
	const later = comment(
		20,
		"2026-07-25T07:00:00Z",
		stampedClaimBody(SID_LATER, "2026-07-25T07:00:00Z", {host: "box-1", pid: 5150}),
	);
	const comments = [legacy, later];

	it("resolves indeterminate, so the legacy claim keeps winning the tiebreak", () => {
		assert.strictEqual(
			claimLiveness(parseClaimPresence(legacy.body), local("box-1", {})),
			"unknown",
		);
		const liveness = livenessByComment(comments, local("box-1", {4242: "gone", 5150: "running"}));
		assert.isFalse(liveness.has(legacy.id), "an unstamped claim must record no liveness at all");
		assert.strictEqual(resolveWinner(comments, AUTHORIZED, liveness)?.session, SID_DEAD);
	});
});
