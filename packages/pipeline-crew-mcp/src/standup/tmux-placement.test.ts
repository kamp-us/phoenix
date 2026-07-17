/**
 * The tmux placement mapping (AC 4): a sample roster session set — three bridges + N engines — maps to one
 * placement target per session, with each window name DERIVED from role identity (a bridge's role slug, an
 * engine's per-instance id) rather than a config `tmux` dimension (which died with the one-role-map seam, ADR
 * 0189 / #3236). The SESSION windows open into is NOT this layer's concern — it is resolved at launch time to
 * the caller's current tmux session (founder ruling #3418), so a target carries no session field. Also pins
 * the one surviving fail-closed rejection: two sessions colliding on one window name.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	computeTmuxPlacement,
	type RosterSession,
	TmuxWindowCollisionError,
} from "./tmux-placement.ts";

// A sample roster: the three bridges + an engine count of N (here N = 3, each engine already
// carrying its per-instance identity from #3297). Bridges name their window by role slug.
const BRIDGES: readonly RosterSession[] = [
	{kind: "bridge", role: "chief-of-staff"},
	{kind: "bridge", role: "cartographer"},
	{kind: "bridge", role: "intake-desk"},
];
const engines = (n: number): readonly RosterSession[] =>
	Array.from({length: n}, (_, i) => ({kind: "engine", id: `engine-${i + 1}`}) as const);

describe("standup/tmux-placement — session set → placement targets (derived naming)", () => {
	it.effect("places one window per bridge + one per engine (no session baked into a target)", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement([...BRIDGES, ...engines(3)]);
			assert.lengthOf(targets, 6, "3 bridges + 3 engines = 6 placement targets");
			for (const t of targets) {
				assert.notProperty(
					t,
					"session",
					"the target carries no session — it is resolved at launch",
				);
			}
		}),
	);

	it.effect("derives each bridge window from its role slug", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(BRIDGES);
			assert.deepStrictEqual(
				targets.map((t) => ({window: t.window, sessionRef: t.sessionRef, kind: t.kind})),
				[
					{window: "chief-of-staff", sessionRef: "chief-of-staff", kind: "bridge"},
					{window: "cartographer", sessionRef: "cartographer", kind: "bridge"},
					{window: "intake-desk", sessionRef: "intake-desk", kind: "bridge"},
				],
			);
		}),
	);

	it.effect("names each engine window from its per-instance id (distinct across the count)", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(engines(4));
			assert.deepStrictEqual(
				targets.map((t) => ({window: t.window, sessionRef: t.sessionRef, kind: t.kind})),
				[
					{window: "engine-1", sessionRef: "engine-1", kind: "engine"},
					{window: "engine-2", sessionRef: "engine-2", kind: "engine"},
					{window: "engine-3", sessionRef: "engine-3", kind: "engine"},
					{window: "engine-4", sessionRef: "engine-4", kind: "engine"},
				],
			);
			assert.strictEqual(
				new Set(targets.map((t) => t.window)).size,
				4,
				"engine windows are distinct",
			);
		}),
	);

	it.effect("fails closed when two sessions collide on one window", () =>
		Effect.gen(function* () {
			const failure = yield* computeTmuxPlacement([
				{kind: "bridge", role: "chief-of-staff"},
				// an engine whose id equals the already-placed bridge window name
				{kind: "engine", id: "chief-of-staff"},
			]).pipe(Effect.flip);
			assert.instanceOf(failure, TmuxWindowCollisionError);
			assert.strictEqual(failure.window, "chief-of-staff");
			assert.deepStrictEqual([...failure.sessionRefs], ["chief-of-staff", "chief-of-staff"]);
		}),
	);
});
