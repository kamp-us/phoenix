/**
 * The tmux placement mapping (AC 4): a sample roster session set — three bridges + N engines —
 * maps to one placement target per session, all under the operator-configured tmux session, with
 * bridge windows resolved from the operator config's tmux naming and engine windows from each
 * engine's per-instance id. Also pins the two fail-closed rejections: a bridge whose window key
 * the operator config omits, and two sessions colliding on one window. These prove tmux is used
 * only as a window-manager here — the mapping produces placement targets, never a transport path.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	computeTmuxPlacement,
	type RosterSession,
	type TmuxNaming,
	TmuxWindowCollisionError,
	TmuxWindowUnnamedError,
} from "./tmux-placement.ts";

// Operator-configured tmux naming — the shape #3293's reader resolves from the config `tmux`
// dimension. Placeholder values stand in for operator data; the layer never hardcodes them.
const NAMING: TmuxNaming = {
	session: "crew",
	windows: {
		ea: "chief-of-staff",
		engineeringManager: "em",
		triage: "intake-desk",
	},
};

// A sample roster: the three bridges + an engine count of N (here N = 3, each engine already
// carrying its per-instance identity from #3297).
const BRIDGES: readonly RosterSession[] = [
	{kind: "bridge", role: "ea-chief-of-staff", windowKey: "ea"},
	{kind: "bridge", role: "engineering-manager", windowKey: "engineeringManager"},
	{kind: "bridge", role: "triage-guy", windowKey: "triage"},
];
const engines = (n: number): readonly RosterSession[] =>
	Array.from({length: n}, (_, i) => ({kind: "engine", id: `engine-${i + 1}`}) as const);

describe("standup/tmux-placement — session set → placement targets", () => {
	it.effect("places one window per bridge + one per engine, all under the tmux session", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(NAMING, [...BRIDGES, ...engines(3)]);
			assert.lengthOf(targets, 6, "3 bridges + 3 engines = 6 placement targets");
			for (const t of targets) {
				assert.strictEqual(
					t.session,
					"crew",
					"every window lives under the configured tmux session",
				);
			}
		}),
	);

	it.effect("resolves each bridge window from the operator config's tmux naming", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(NAMING, BRIDGES);
			assert.deepStrictEqual(
				targets.map((t) => ({window: t.window, sessionRef: t.sessionRef, kind: t.kind})),
				[
					{window: "chief-of-staff", sessionRef: "ea-chief-of-staff", kind: "bridge"},
					{window: "em", sessionRef: "engineering-manager", kind: "bridge"},
					{window: "intake-desk", sessionRef: "triage-guy", kind: "bridge"},
				],
			);
		}),
	);

	it.effect("names each engine window from its per-instance id (distinct across the count)", () =>
		Effect.gen(function* () {
			const targets = yield* computeTmuxPlacement(NAMING, engines(4));
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

	it.effect("fails closed when a bridge names a window key the operator config omits", () =>
		Effect.gen(function* () {
			const failure = yield* computeTmuxPlacement(NAMING, [
				{kind: "bridge", role: "cartographer", windowKey: "cartographer"},
			]).pipe(Effect.flip);
			assert.instanceOf(failure, TmuxWindowUnnamedError);
			assert.strictEqual(failure.windowKey, "cartographer");
			assert.strictEqual(failure.role, "cartographer");
		}),
	);

	it.effect("fails closed when two sessions collide on one window", () =>
		Effect.gen(function* () {
			const failure = yield* computeTmuxPlacement(NAMING, [
				{kind: "bridge", role: "ea-chief-of-staff", windowKey: "ea"},
				// an engine whose id equals the already-placed bridge window name
				{kind: "engine", id: "chief-of-staff"},
			]).pipe(Effect.flip);
			assert.instanceOf(failure, TmuxWindowCollisionError);
			assert.strictEqual(failure.window, "chief-of-staff");
			assert.deepStrictEqual([...failure.sessionRefs], ["ea-chief-of-staff", "chief-of-staff"]);
		}),
	);
});
