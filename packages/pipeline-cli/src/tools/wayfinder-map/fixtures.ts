/**
 * Test fixtures — small builders for the map domain shapes and a canonical
 * well-formed map body, so each test states only what it varies. Plain TS, no
 * Effect (per `.patterns/effect-testing.md` §Helpers).
 */
import type {WayfinderMap, WayfinderMapLedger} from "./Map.ts";

/** A canonical, well-formed `wayfinder:map` body — the formats §worked-example shape. */
export const cleanMapBody = `## Destination
kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new person in.

## Decisions-so-far
- Invites are karma-gated, not seat-gated. — from #101
- The invite artifact is a single-use signed link. — from #102

## Open frontier
- #103 — Investigation: does better-auth's session model let us mint a single-use invite token?
- #104 — Decision (founder-decision-fork): should an invited çaylak start at 0 karma?

## Graduated fog
- #101 — Decided invites are karma-gated. → spawned #104
- #102 — Decided the artifact is a signed link. → spawned #103
`;

/**
 * A well-formed parsed map: two decisions (each attributed), an answerable
 * frontier ticket (#103) and a founder-decision-fork (#104), and two graduated
 * fog entries. Overrides let a test vary one section.
 */
export const map = (overrides: Partial<WayfinderMap> = {}): WayfinderMap => ({
	destination: {present: true, text: "A working invite flow."},
	decisionsSoFar: {
		present: true,
		entries: [
			{text: "Invites are karma-gated. — from #101", fromIssue: 101},
			{text: "The artifact is a signed link. — from #102", fromIssue: 102},
		],
	},
	openFrontier: {
		present: true,
		entries: [
			{issue: 103, question: "#103 — Investigation: token storage?", founderDecisionFork: false},
			{
				issue: 104,
				question: "#104 — Decision (founder-decision-fork): starting karma?",
				founderDecisionFork: true,
			},
		],
	},
	graduatedFog: {
		present: true,
		entries: [
			{issue: 101, note: "#101 — Decided karma-gated. → spawned #104", spawned: [104]},
			{issue: 102, note: "#102 — Decided signed link. → spawned #103", spawned: [103]},
		],
	},
	...overrides,
});

/** A decoded ledger over a well-formed map whose frontier refs are real sub-issues. */
export const ledger = (overrides: Partial<WayfinderMapLedger> = {}): WayfinderMapLedger => ({
	number: 100,
	map: map(),
	subIssues: [101, 102, 103, 104],
	...overrides,
});
