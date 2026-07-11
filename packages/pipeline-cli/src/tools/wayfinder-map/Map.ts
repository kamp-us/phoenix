/**
 * The wayfinder-map domain model as Effect Schema — the decoded, validated shape
 * the floor validator runs over.
 *
 * A `WayfinderMapLedger` is a `wayfinder:map` issue's parsed state: the four map
 * sections (`## Destination` / `## Decisions-so-far` / `## Open frontier` /
 * `## Graduated fog`, parsed off the body per the formats contract) plus the set
 * of the map's real sub-issue numbers, resolved at the GitHub boundary. The shape
 * is deliberately post-parse: markdown has already been lowered to structured
 * entries, so `validateMap` / `isGraduationReady` are pure functions over data,
 * never parsers. Decoding GitHub JSON into this shape is the boundary
 * (`github.ts`); everything downstream is total over a decoded ledger.
 *
 * The four-section contract this mirrors is single-sourced in
 * `gh-issue-intake-formats.md` §The `wayfinder:map` issue shape — this model is a
 * consumer of that contract, not a second definition of it.
 */
import * as Schema from "effect/Schema";

/**
 * A `## Decisions-so-far` entry: one settled decision/fact and the frontier
 * ticket it came from. `fromIssue` is the `— from #N` attribution; `undefined`
 * records an entry with no attribution at all, which `validateMap` flags as
 * `MALFORMED_DECISION_ENTRY` (the answer log's growing spine must stay auditable
 * back to its frontier origin).
 */
export const Decision = Schema.Struct({
	text: Schema.String,
	fromIssue: Schema.optional(Schema.Number),
});
export type Decision = (typeof Decision)["Type"];

/**
 * An `## Open frontier` ticket: one open investigation/decision, kept as a native
 * sub-issue of the map. `issue` is the referenced sub-issue number; `undefined`
 * records a list item with no `#N` at all → `MALFORMED_FRONTIER_ENTRY`.
 * `founderDecisionFork` marks the preserved human seam — a ticket `wayfinder`
 * surfaces and stops on rather than auto-resolving; it is the one frontier kind
 * that does not block graduation-readiness (nothing the automated loop can clear).
 */
export const FrontierTicket = Schema.Struct({
	issue: Schema.optional(Schema.Number),
	question: Schema.String,
	founderDecisionFork: Schema.Boolean,
});
export type FrontierTicket = (typeof FrontierTicket)["Type"];

/**
 * A `## Graduated fog` entry: a now-closed frontier ticket whose answer landed in
 * `## Decisions-so-far`. `issue` is the graduated sub-issue; `undefined` → a list
 * item with no `#N` → `MALFORMED_FOG_ENTRY`. `spawned` is the follow-on frontier
 * it opened (`→ spawned #M`) — the map's record of forward motion; empty when the
 * graduation opened no new unknown.
 */
export const FogEntry = Schema.Struct({
	issue: Schema.optional(Schema.Number),
	note: Schema.String,
	spawned: Schema.Array(Schema.Number),
});
export type FogEntry = (typeof FogEntry)["Type"];

/**
 * One parsed map section: `present` records whether the heading existed at all
 * (its absence is the section's `MISSING_*` defect), distinct from a present but
 * empty section. The `## Destination` section carries free `text`; the three list
 * sections carry structured `entries`.
 */
export const DestinationSection = Schema.Struct({
	present: Schema.Boolean,
	text: Schema.String,
});
export type DestinationSection = (typeof DestinationSection)["Type"];

/**
 * The four parsed sections of a `wayfinder:map` body. Markdown has already been
 * lowered here; the section-present flags plus the structured entries are all the
 * validator and the graduation-readiness predicate read.
 */
export const WayfinderMap = Schema.Struct({
	destination: DestinationSection,
	decisionsSoFar: Schema.Struct({
		present: Schema.Boolean,
		entries: Schema.Array(Decision),
	}),
	openFrontier: Schema.Struct({
		present: Schema.Boolean,
		entries: Schema.Array(FrontierTicket),
	}),
	graduatedFog: Schema.Struct({
		present: Schema.Boolean,
		entries: Schema.Array(FogEntry),
	}),
});
export type WayfinderMap = (typeof WayfinderMap)["Type"];

/**
 * A `wayfinder:map` issue's full parsed state: its number, its parsed four-section
 * `map`, and `subIssues` — the map's real GitHub sub-issue numbers. `subIssues`
 * is resolved at the GitHub boundary (`github.ts`), never by parsing the body; it
 * is empty on a pure decode and overridden by the loader. The pure floor flags a
 * frontier ref that names an issue absent from this set as `DANGLING_FRONTIER_REF`
 * — so a frontier ticket that really is a sub-issue is allowed through, while a
 * typo'd or stale ref is caught. An empty `subIssues` disables the check (nothing
 * resolved to compare against — the foreign/offline graceful-absence case).
 */
export const WayfinderMapLedger = Schema.Struct({
	number: Schema.Number,
	map: WayfinderMap,
	subIssues: Schema.Array(Schema.Number),
});
export type WayfinderMapLedger = (typeof WayfinderMapLedger)["Type"];
