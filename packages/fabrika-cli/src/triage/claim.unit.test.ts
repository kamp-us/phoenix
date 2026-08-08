import {describe, expect, it} from "vitest";
import {
	expiryOf,
	MARKER_PREFIX,
	markerBody,
	markersOf,
	myMarker,
	resolveClaim,
	sessionOf,
} from "./claim.ts";

const MINE = "b2e1-4c07-4a99-9f30-55da1e6b7c02";
const THEIRS = "7f3c-9a20-4b11-8e05-1d77c2a4f9be";

const at = (iso: string) => Date.parse(iso);

const marker = (id: number, session: string, createdAt: string) => ({
	id,
	session,
	createdAt,
});

describe("markerBody / sessionOf", () => {
	it("round-trips the exact one-line literal", () => {
		expect(markerBody(MINE)).toBe(`${MARKER_PREFIX}${MINE} -->`);
		expect(sessionOf(markerBody(MINE))).toBe(MINE);
	});

	it("ignores any comment that does not carry the prefix", () => {
		expect(sessionOf("I am triaging this one, hands off")).toBeNull();
		expect(sessionOf(`prose then ${markerBody(MINE)}`)).toBeNull();
	});

	it("reads a malformed marker as a foreign claim, never as absent", () => {
		// Some session posted it. Dropping it would silently ignore a live competitor, which is the
		// one direction the protocol may not fail.
		expect(sessionOf(`${MARKER_PREFIX} -->`)).toBe("");
		expect(sessionOf(`${MARKER_PREFIX}${MINE}`)).toBe(MINE);
	});
});

describe("markersOf", () => {
	it("keeps only the marker comments, in read order", () => {
		expect(
			markersOf([
				{id: 1, createdAt: "2026-08-02T09:00:00Z", body: "a human comment"},
				{id: 2, createdAt: "2026-08-02T09:14:02Z", body: markerBody(THEIRS)},
				{id: 3, createdAt: "2026-08-02T09:15:00Z", body: markerBody(MINE)},
			]),
		).toEqual([
			{id: 2, session: THEIRS, createdAt: "2026-08-02T09:14:02Z"},
			{id: 3, session: MINE, createdAt: "2026-08-02T09:15:00Z"},
		]);
	});
});

describe("resolveClaim", () => {
	const now = at("2026-08-02T10:00:00Z");

	it("wins only when the earliest surviving marker is this session's", () => {
		const out = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z")],
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		expect(out).toMatchObject({_tag: "Won", live: 1, expired: 0});
	});

	it("loses to an earlier live marker and names the holder", () => {
		const out = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z"), marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			session: MINE,
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
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Lost");
	});

	it("discards a marker older than the TTL and counts it", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T08:00:00Z"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		expect(out).toMatchObject({_tag: "Won", live: 1, expired: 1});
	});

	it("keeps a marker exactly at the TTL boundary binding", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T09:00:00Z"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Lost");
	});

	it("REFUSES rather than answering when an ordering key will not parse — `won` needs proof", () => {
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "not-a-timestamp"), marker(3, MINE, "2026-08-02T09:50:00Z")],
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).toBe("Unresolvable");
	});

	it("reports MineAbsent — never Won — when no marker of this session survives", () => {
		expect(resolveClaim({markers: [], session: MINE, now, ttlMinutes: 60})._tag).toBe("MineAbsent");
		expect(
			resolveClaim({
				markers: [marker(2, THEIRS, "2026-08-02T09:14:02Z")],
				session: MINE,
				now,
				ttlMinutes: 60,
			})._tag,
		).toBe("MineAbsent");
	});

	it("never resolves Won for a session that is not the caller's, whatever the marker set", () => {
		// The fail-open shape v1 shipped: an empty identity compared equal to everything. Here an
		// empty session matches only a marker that literally carries none.
		const out = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			session: "",
			now,
			ttlMinutes: 60,
		});
		expect(out._tag).not.toBe("Won");

		// With a marker of its own present the MineAbsent branch no longer short-circuits, so the
		// winner comparison itself runs — which is where the empty identity would compare equal. This
		// case, not the one above, is what pins it.
		const holdingOne = resolveClaim({
			markers: [marker(2, THEIRS, "2026-08-02T09:14:02Z"), marker(3, "", "2026-08-02T09:50:00Z")],
			session: "",
			now,
			ttlMinutes: 60,
		});
		expect(holdingOne._tag).toBe("Lost");
	});
});

describe("myMarker", () => {
	it("finds this session's marker on both resolved outcomes and nowhere else", () => {
		const now = at("2026-08-02T10:00:00Z");
		const won = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z")],
			session: MINE,
			now,
			ttlMinutes: 60,
		});
		const lost = resolveClaim({
			markers: [marker(3, MINE, "2026-08-02T09:50:00Z"), marker(2, THEIRS, "2026-08-02T09:14:02Z")],
			session: MINE,
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
