import {assert, describe, it} from "@effect/vitest";
import {
	liveSessionIds,
	parseOwnerStamp,
	resolveOwnerLiveness,
	sessionIdFromPath,
} from "./owner-liveness.ts";

const SID_A = "85123b6c-d220-46c5-ac19-77ccedffb3d7";
const SID_B = "ddf8f459-b75f-4de2-9051-8df10da5b55c";

describe("parseOwnerStamp", () => {
	it("reads the sessionId and the ownerKind the WorktreeCreate hook stamped", () => {
		const raw = `{"sessionId":"${SID_A}","ownerKind":"launcher","worktreeName":"agent-abc","stampedAt":"2026-07-24T22:00:00Z"}`;
		assert.deepStrictEqual(parseOwnerStamp(raw), {sessionId: SID_A, kind: "launcher"});
	});

	it("reads a LEGACY stamp with no ownerKind as a launcher — every stamp ever written is one (#4001)", () => {
		const raw = `{"sessionId":"${SID_A}","worktreeName":"agent-abc"}`;
		assert.deepStrictEqual(parseOwnerStamp(raw), {sessionId: SID_A, kind: "launcher"});
	});

	it("only an explicit ownerKind:occupant claims occupant authority; anything else reads launcher", () => {
		assert.deepStrictEqual(parseOwnerStamp(`{"sessionId":"${SID_A}","ownerKind":"occupant"}`), {
			sessionId: SID_A,
			kind: "occupant",
		});
		assert.deepStrictEqual(parseOwnerStamp(`{"sessionId":"${SID_A}","ownerKind":"pane"}`), {
			sessionId: SID_A,
			kind: "launcher",
		});
		assert.deepStrictEqual(parseOwnerStamp(`{"sessionId":"${SID_A}","ownerKind":7}`), {
			sessionId: SID_A,
			kind: "launcher",
		});
	});

	it("returns null for malformed JSON, a missing field, and a non-UUID id (⇒ unknown ⇒ KEEP)", () => {
		assert.isNull(parseOwnerStamp("{not json"));
		assert.isNull(parseOwnerStamp('{"worktreeName":"agent-abc"}'));
		assert.isNull(parseOwnerStamp('{"sessionId":"pending"}'));
		assert.isNull(parseOwnerStamp('{"sessionId":""}'));
	});
});

describe("sessionIdFromPath", () => {
	it("recovers the owning session from a session-rooted $TMPDIR review-head path", () => {
		assert.strictEqual(
			sessionIdFromPath(`/private/tmp/claude-501/-Users-dev-phoenix/${SID_A}/scratchpad/rh-3917`),
			SID_A,
		);
	});

	it("returns null when no segment is a bare session UUID (an unrooted $TMPDIR)", () => {
		assert.isNull(sessionIdFromPath("/private/var/folders/8f/tmp.ZE2abJOOnR/review-head-3861"));
	});

	it("returns null on AMBIGUITY — two different UUID segments could name a dead owner for a live tree", () => {
		assert.isNull(sessionIdFromPath(`/tmp/${SID_A}/nested/${SID_B}/scratchpad/review-head-1`));
	});

	it("does not read a UUID embedded inside a longer segment as the owner", () => {
		assert.isNull(sessionIdFromPath(`/private/tmp/claude-501/-Users-dev-crew-run-${SID_A}/wt`));
	});
});

describe("liveSessionIds — the registry trust gate", () => {
	it("returns the alive session ids when the registry is readable and has a live entry", () => {
		const live = liveSessionIds({
			readable: true,
			entries: [
				{sessionId: SID_A, alive: true},
				{sessionId: SID_B, alive: false},
			],
		});
		assert.deepStrictEqual(live === null ? null : [...live], [SID_A]);
	});

	it("returns null when the registry directory could not be enumerated (probe could not execute)", () => {
		assert.isNull(liveSessionIds({readable: false, entries: []}));
	});

	it("returns null when NO entry is alive — the sweep itself runs inside a live session, so an empty live set means the registry is untrustworthy, never 'nothing is running'", () => {
		assert.isNull(liveSessionIds({readable: true, entries: []}));
		assert.isNull(liveSessionIds({readable: true, entries: [{sessionId: SID_A, alive: false}]}));
	});
});

describe("resolveOwnerLiveness", () => {
	const live: ReadonlySet<string> = new Set([SID_A]);
	const launcher = (sessionId: string) => ({sessionId, kind: "launcher"}) as const;
	const occupant = (sessionId: string) => ({sessionId, kind: "occupant"}) as const;

	it("resolves ALIVE when the live owner is the OCCUPANT — real presence", () => {
		assert.strictEqual(
			resolveOwnerLiveness({owner: occupant(SID_A), liveSessionIds: live}),
			"alive",
		);
	});

	// The #4001 case: a launcher pane runs for hours and spawns many short-lived subagent trees, so its
	// liveness says nothing about whether any given tree is still occupied. Collapsing this into
	// "alive" is what kept every tree such a pane ever created for the pane's whole lifetime.
	it("resolves LAUNCHER-ALIVE — not alive — when the live owner is the LAUNCHER (#4001)", () => {
		assert.strictEqual(
			resolveOwnerLiveness({owner: launcher(SID_A), liveSessionIds: live}),
			"launcher-alive",
		);
	});

	it("matches case-insensitively (the UUID's hex case is not identity)", () => {
		assert.strictEqual(
			resolveOwnerLiveness({owner: occupant(SID_A.toUpperCase()), liveSessionIds: live}),
			"alive",
		);
	});

	it("resolves DEAD only for a resolvable owner absent from a trusted live set, whichever kind", () => {
		assert.strictEqual(
			resolveOwnerLiveness({owner: launcher(SID_B), liveSessionIds: live}),
			"dead",
		);
		assert.strictEqual(
			resolveOwnerLiveness({owner: occupant(SID_B), liveSessionIds: live}),
			"dead",
		);
	});

	it("resolves UNKNOWN — never dead — for an unresolvable owner (no stamp, no session in the path)", () => {
		assert.strictEqual(resolveOwnerLiveness({owner: null, liveSessionIds: live}), "unknown");
	});

	it("resolves UNKNOWN — never dead — for every owner when the registry is untrustworthy", () => {
		assert.strictEqual(
			resolveOwnerLiveness({owner: launcher(SID_B), liveSessionIds: null}),
			"unknown",
		);
		assert.strictEqual(resolveOwnerLiveness({owner: null, liveSessionIds: null}), "unknown");
	});
});
