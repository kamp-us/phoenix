import {describe, expect, it} from "vitest";
import {
	anySessionCaller,
	claimNonceOf,
	composeClaimToken,
	expiryOf,
	isStampableSession,
	laneCaller,
	laneOf,
	MARKER_PREFIX,
	markerBody,
	markersOf,
	myMarker,
	parseClaimToken,
	resolveClaim,
	sessionOf,
} from "./claim.ts";

const MINE = "b2e1-4c07-4a99-9f30-55da1e6b7c02";
const THEIRS = "7f3c-9a20-4b11-8e05-1d77c2a4f9be";

const MY_LANE = "aaaaaaaa";
const SIBLING_LANE = "bbbbbbbb";
const THEIR_LANE = "cccccccc";

/** The lane every case below asks as, and the sibling that shares its session and nothing else. */
const me = laneCaller(MINE, MY_LANE);
const sibling = laneCaller(MINE, SIBLING_LANE);

const at = (iso: string) => Date.parse(iso);

const body = (session: string, nonce: string) => markerBody({session, nonce});

const marker = (
	id: number,
	session: string,
	createdAt: string,
	lane: string | null = session === MINE ? MY_LANE : THEIR_LANE,
) => ({id, session, lane, createdAt});

describe("markerBody / sessionOf / laneOf", () => {
	it("round-trips the exact one-line literal, session and lane both", () => {
		expect(body(MINE, MY_LANE)).toBe(`${MARKER_PREFIX}${MINE} lane=${MY_LANE} -->`);
		expect(sessionOf(body(MINE, MY_LANE))).toBe(MINE);
		expect(laneOf(body(MINE, MY_LANE))).toBe(MY_LANE);
	});

	it("ignores any comment that does not carry the prefix", () => {
		expect(sessionOf("I am triaging this one, hands off")).toBeNull();
		expect(sessionOf(`prose then ${body(MINE, MY_LANE)}`)).toBeNull();
		expect(laneOf("I am triaging this one, hands off")).toBeNull();
	});

	it("reads a malformed marker as a foreign claim, never as absent", () => {
		// Some session posted it. Dropping it would silently ignore a live competitor, which is the
		// one direction the protocol may not fail.
		expect(sessionOf(`${MARKER_PREFIX} -->`)).toBe("");
		expect(sessionOf(`${MARKER_PREFIX}${MINE}`)).toBe(MINE);
	});

	it("reads a pre-#6132 session-only marker as a claim carrying no lane", () => {
		const legacy = `${MARKER_PREFIX}${MINE} -->`;
		expect(sessionOf(legacy)).toBe(MINE);
		expect(laneOf(legacy)).toBeNull();
	});

	it("never reads a session id that begins `lane=` as its own lane nonce", () => {
		expect(laneOf(`${MARKER_PREFIX}lane=forged -->`)).toBeNull();
	});
});

describe("the triage claim token", () => {
	it("carries its own namespace and confers the nonce the marker is stamped with", () => {
		const token = composeClaimToken(MINE, "aaaaaaaa-1111-4222-8333-444444444444");
		expect(token).toBe(`triage:${MINE}:aaaaaaaa-1111-4222-8333-444444444444`);
		expect(parseClaimToken(token)).toEqual({
			session: MINE,
			uuid: "aaaaaaaa-1111-4222-8333-444444444444",
		});
		expect(claimNonceOf(token)).toBe(MY_LANE);
	});

	it("does not parse another namespace's token — a build lane is not a triage lane", () => {
		expect(parseClaimToken(`build:${MINE}:aaaaaaaa-1111-4222-8333-444444444444`)).toBeNull();
		expect(claimNonceOf("not-a-token")).toBeNull();
	});
});

describe("isStampableSession", () => {
	it("accepts a single whitespace-free token", () => {
		expect(isStampableSession(MINE)).toBe(true);
	});

	it("rejects an id carrying whitespace — it would read back as a different session", () => {
		expect(isStampableSession("two tokens")).toBe(false);
		expect(isStampableSession("")).toBe(false);
	});

	it("rejects an id carrying `-->` — it would close the comment and escape as body text", () => {
		// Both halves of the guard are load-bearing, and only the whitespace half fails loudly. An id
		// containing `-->` is a single token, so it passes the first half; what it produces is
		// `<!-- fabrika-triage-claim session=-->@here lane=x -->`, whose comment ends at the FIRST
		// `-->` and renders the rest as visible markdown in the comment this verb posts.
		expect(isStampableSession("-->x")).toBe(false);
		expect(isStampableSession("-->@here")).toBe(false);
		// the escape itself, so the guard is pinned to the thing it prevents rather than to a literal
		const escaped = body("-->@here", MY_LANE);
		expect(escaped.indexOf("-->")).toBeLessThan(escaped.length - "-->".length);
	});
});

describe("markersOf", () => {
	it("keeps only the marker comments, in read order, with the lane each names", () => {
		expect(
			markersOf([
				{id: 1, createdAt: "2026-08-02T09:00:00Z", body: "a human comment"},
				{id: 2, createdAt: "2026-08-02T09:14:02Z", body: body(THEIRS, THEIR_LANE)},
				{id: 3, createdAt: "2026-08-02T09:15:00Z", body: body(MINE, MY_LANE)},
				{id: 4, createdAt: "2026-08-02T09:16:00Z", body: `${MARKER_PREFIX}${MINE} -->`},
			]),
		).toEqual([
			{id: 2, session: THEIRS, lane: THEIR_LANE, createdAt: "2026-08-02T09:14:02Z"},
			{id: 3, session: MINE, lane: MY_LANE, createdAt: "2026-08-02T09:15:00Z"},
			{id: 4, session: MINE, lane: null, createdAt: "2026-08-02T09:16:00Z"},
		]);
	});
});

describe("resolveClaim", () => {
	const now = at("2026-08-02T10:00:00Z");

	it("wins only when the earliest surviving marker is this lane's", () => {
		const out = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out).toMatchObject({_tag: "Won", live: 1, expired: 0});
	});

	it("loses to an earlier live marker and names the holder", () => {
		const out = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z"), marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out).toMatchObject({_tag: "Lost"});
		if (out._tag !== "Lost") throw new Error("unreachable");
		expect(out.holder.session).toBe(THEIRS);
		expect(out.mine.id).toBe(3);
	});

	it("breaks a created_at tie on the lower comment id", () => {
		const same = "2026-08-02T09:50:00Z";
		const out = resolveClaim({
			markers: [marker(9, MINE, same), marker(4, THEIRS, same)],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Lost");
	});

	it("discards a marker older than the TTL and counts it", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T08:00:00Z"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out).toMatchObject({_tag: "Won", live: 1, expired: 1});
	});

	it("keeps a marker exactly at the TTL boundary binding", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T09:00:00Z"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Lost");
	});

	it("REFUSES rather than answering when an ordering key will not parse — `won` needs proof", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "not-a-timestamp"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Unresolvable");
	});

	it("reports MineAbsent — never Won — when no marker of this lane survives", () => {
		expect(resolveClaim({markers: [], caller: me, now, ttlMinutes: 60})._tag).toBe("MineAbsent");
		expect(
			resolveClaim({
				markers: [marker(2, THEIRS, "2026-08-02T09:14:02Z")],
				caller: me,
				now,
				ttlMinutes: 60,
			})._tag,
		).toBe("MineAbsent");
	});

	it("never resolves Won for a session that is not the caller's, whatever the marker set", () => {
		// The fail-open shape v1 shipped: an empty identity compared equal to everything. Here an
		// empty session matches only a marker that literally carries none.
		const nameless = laneCaller("", MY_LANE);
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			caller: nameless,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).not.toBe("Won");

		// With a marker of its own present the MineAbsent branch no longer short-circuits, so the
		// winner comparison itself runs — which is where the empty identity would compare equal. This
		// case, not the one above, is what pins it.
		const holdingOne = resolveClaim({
			markers: [
				marker(2, THEIRS, "2026-08-02T09:14:02Z"),
				marker(3, "", "2026-08-02T09:50:00Z", MY_LANE),
			],
			caller: nameless,
			now,
			ttlMinutes: 60,
		});
		expect(holdingOne._tag).toBe("Lost");
	});
});

describe("resolveClaim — two lanes of one session", () => {
	const now = at("2026-08-02T10:00:00Z");
	// #6132: both siblings of a fan-out carry one CLAUDE_CODE_SESSION_ID. Resolved on the session id
	// alone, each read the other's marker back as its own and BOTH answered `won`.
	const markers = [
		{id: 2, session: MINE, lane: SIBLING_LANE, createdAt: "2026-08-02T09:14:02Z"},
		{id: 3, session: MINE, lane: MY_LANE, createdAt: "2026-08-02T09:50:00Z"},
	];

	it("hands the claim to exactly one of them — never both", () => {
		const mine = resolveClaim({markers, caller: me, now, ttlMinutes: 60});
		const theirs = resolveClaim({markers, caller: sibling, now, ttlMinutes: 60});
		expect([mine._tag, theirs._tag].filter((tag) => tag === "Won")).toHaveLength(1);
		expect(theirs._tag).toBe("Won");
		expect(mine._tag).toBe("Lost");
	});

	it("gives the loser its OWN marker to retract, never the winner's", () => {
		const mine = resolveClaim({markers, caller: me, now, ttlMinutes: 60});
		expect(myMarker(mine)?.id).toBe(3);
		if (mine._tag !== "Lost") throw new Error("unreachable");
		expect(mine.holder.id).toBe(2);
		expect(mine.holder.lane).toBe(SIBLING_LANE);
	});

	it("reads a sibling's marker as absent, not as its own, when it holds none itself", () => {
		const only = [markers[0] as (typeof markers)[number]];
		expect(resolveClaim({markers: only, caller: me, now, ttlMinutes: 60})._tag).toBe("MineAbsent");
	});

	it("treats a pre-#6132 session-only marker as another claimant's", () => {
		const legacy = [{id: 2, session: MINE, lane: null, createdAt: "2026-08-02T09:14:02Z"}];
		expect(resolveClaim({markers: legacy, caller: me, now, ttlMinutes: 60})._tag).toBe(
			"MineAbsent",
		);
	});

	it("still resolves on the session alone for a caller that named no lane", () => {
		// The opt-in the readers with no nonce of their own keep — named, never a default.
		const out = resolveClaim({markers, caller: anySessionCaller(MINE), now, ttlMinutes: 60});
		expect(out._tag).toBe("Won");
	});
});

describe("myMarker", () => {
	it("finds this lane's marker on both resolved outcomes and nowhere else", () => {
		const now = at("2026-08-02T10:00:00Z");
		const won = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		const lost = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z"), marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			caller: me,
			now,
			ttlMinutes: 60,
		});
		expect(myMarker(won)?.id).toBe(3);
		expect(myMarker(lost)?.id).toBe(3);
		expect(myMarker({_tag: "Unresolvable", reason: "r"})).toBeNull();
		expect(myMarker({_tag: "MineAbsent", live: 0, expired: 0})).toBeNull();
	});
});

describe("expiryOf", () => {
	it("adds the TTL to the comment's own created_at", () => {
		expect(expiryOf("2026-08-02T09:14:02Z", 60)).toBe("2026-08-02T10:14:02.000Z");
	});

	it("is null when the created_at will not parse", () => {
		expect(expiryOf("nope", 60)).toBeNull();
	});
});
