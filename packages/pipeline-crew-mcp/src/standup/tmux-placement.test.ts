/**
 * The tmux placement mapping (AC 4): a sample roster session set — three bridges + N engines — maps to one
 * placement target per session, with each pane label DERIVED from role identity (a bridge's role slug, an
 * engine's per-instance id) rather than a config `tmux` dimension (which died with the one-role-map seam, ADR
 * 0189 / #3236). The single crew window the panes tile in is named at launch, and the SESSION it opens under
 * is resolved at launch to the caller's current tmux session (founder ruling #3418/#3424) — so a target carries
 * neither. Also pins the one surviving fail-closed rejection: two sessions colliding on one pane label.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	computeTmuxPlacement,
	type RosterSession,
	TmuxPaneCollisionError,
} from "./tmux-placement.ts";

// A sample roster: the three bridges + an engine count of N (here N = 3, each engine already
// carrying its per-instance identity from #3297). Bridges label their pane by role slug.
const BRIDGES: readonly RosterSession[] = [
	{kind: "bridge", role: "chief-of-staff"},
	{kind: "bridge", role: "cartographer"},
	{kind: "bridge", role: "intake-desk"},
];
const engines = (n: number): readonly RosterSession[] =>
	Array.from({length: n}, (_, i) => ({kind: "engine", id: `engine-${i + 1}`}) as const);

describe("standup/tmux-placement — session set → placement targets (derived naming)", () => {
	it.effect(
		"places one pane per bridge + one per engine (no session/window baked into a target)",
		() =>
			Effect.gen(function* () {
				const targets = yield* computeTmuxPlacement([...BRIDGES, ...engines(3)]);
				assert.lengthOf(targets, 6, "3 bridges + 3 engines = 6 placement targets");
				for (const t of targets) {
					assert.notProperty(
						t,
						"session",
						"the target carries no session — it is resolved at launch",
					);
					assert.notProperty(t, "window", "the target carries no window — it is named at launch");
				}
			}),
	);

	it.effect("derives each bridge pane label from its role slug", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(BRIDGES);
			assert.deepStrictEqual(
				targets.map((t) => ({paneLabel: t.paneLabel, sessionRef: t.sessionRef, kind: t.kind})),
				[
					{paneLabel: "chief-of-staff", sessionRef: "chief-of-staff", kind: "bridge"},
					{paneLabel: "cartographer", sessionRef: "cartographer", kind: "bridge"},
					{paneLabel: "intake-desk", sessionRef: "intake-desk", kind: "bridge"},
				],
			);
		}),
	);

	it.effect("labels each engine pane from its per-instance id (distinct across the count)", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(engines(4));
			assert.deepStrictEqual(
				targets.map((t) => ({paneLabel: t.paneLabel, sessionRef: t.sessionRef, kind: t.kind})),
				[
					{paneLabel: "engine-1", sessionRef: "engine-1", kind: "engine"},
					{paneLabel: "engine-2", sessionRef: "engine-2", kind: "engine"},
					{paneLabel: "engine-3", sessionRef: "engine-3", kind: "engine"},
					{paneLabel: "engine-4", sessionRef: "engine-4", kind: "engine"},
				],
			);
			assert.strictEqual(
				new Set(targets.map((t) => t.paneLabel)).size,
				4,
				"engine pane labels are distinct",
			);
		}),
	);

	it.effect("fails closed when two sessions collide on one pane label", () =>
		Effect.gen(function* () {
			const failure = yield* computeTmuxPlacement([
				{kind: "bridge", role: "chief-of-staff"},
				// an engine whose id equals the already-placed bridge pane label
				{kind: "engine", id: "chief-of-staff"},
			]).pipe(Effect.flip);
			assert.instanceOf(failure, TmuxPaneCollisionError);
			assert.strictEqual(failure.paneLabel, "chief-of-staff");
			assert.deepStrictEqual([...failure.sessionRefs], ["chief-of-staff", "chief-of-staff"]);
		}),
	);
});
