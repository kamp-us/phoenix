/**
 * Parse ship-it Step 5.5's **reconcile budget** and **merge-disposition rendering** out of
 * `ship-it/SKILL.md`, so the executable mirror in `step55-contract.unit.test.ts` derives both from
 * the shell it mirrors instead of hand-copying them (#4403). Same drift-proof idiom as
 * `class-probe`'s `HAS_*_RE` parse and `checks/step3-contract.ts`: the skill's fenced block stays
 * the single source, this reads it, no second copy exists to rot. No classification logic is
 * relocated here — the poll verdict remains `merge-queue-classify`'s, the disposition wording
 * remains the skill's.
 *
 * Fail-closed in one direction only: a renamed Step 5.5, an unreadable sourced script, a budget the
 * block never binds, or a missing `case` arm all resolve to a ZERO horizon and NO dispositions —
 * which makes the consuming assertions red (a zero horizon covers no dwell, an absent disposition
 * matches no contract), never quietly green.
 *
 * The parse is **extraction-invariant**: the block lives in `scripts/step5_5-reconcile.sh`, and the
 * section's `. "$SHIPIT_SCRIPTS/…"` line is followed into it (`skill-shell-surface.ts`, #4498). It
 * reads the budget and the case arms wherever they sit — inline in the markdown or in the sourced
 * script — so a pure relocation neither reds this nor, worse, quietly empties it.
 */

import {
	type ResolvedSection,
	resolveSection,
	type SkillSurface,
} from "../../skill-shell-surface.ts";

/** The reconcile's poll budget as Step 5.5 states it, plus the horizon it actually observes. */
export interface ReconcileBudget {
	/** `RECONCILE_TRIES` default — the number of polls. 0 when unresolvable. */
	readonly tries: number;
	/** `RECONCILE_SLEEP` default — seconds between polls. 0 when unresolvable. */
	readonly sleepSeconds: number;
	/**
	 * Seconds from the first poll to the LAST one — `(tries - 1) * sleep`. This, not
	 * `tries * sleep`, is what the run observed: poll k fires at `(k-1)*sleep`.
	 */
	readonly horizonSeconds: number;
	/**
	 * Is the `sleep` guarded so it runs only BETWEEN polls? A trailing sleep after the final poll
	 * observes nothing and makes any reported horizon overstate the observation's reach.
	 */
	readonly sleepsBetweenPollsOnly: boolean;
}

export const FAILCLOSED_RECONCILE_BUDGET: ReconcileBudget = {
	tries: 0,
	sleepSeconds: 0,
	horizonSeconds: 0,
	sleepsBetweenPollsOnly: false,
};

/**
 * The Step 5.5 section: its `### Step 5.5 — …` heading up to the next `## `/`### ` heading. Two
 * boundaries this scan must not trip over: it starts after the heading's own LINE (searching from
 * one character in would re-match the heading itself — `### ` minus a char is still `## `), and it
 * requires at least two hashes, because the step's fenced shell blocks are full of `# …` comment
 * lines at column 0. A `####` subsection does not end it — four hashes then a space matches neither
 * bound, so Step 5.5's later prose stays in scope.
 */
export const extractStep55Section = (shipItText: string): string => {
	const start = shipItText.search(/^### Step 5\.5 — /m);
	if (start < 0) return "";
	const section = shipItText.slice(start);
	const bodyAt = section.indexOf("\n") + 1;
	if (bodyAt === 0) return section;
	const end = section.slice(bodyAt).search(/^#{2,3} /m);
	return end < 0 ? section : section.slice(0, bodyAt + end);
};

/**
 * Step 5.5's full shell surface: the heading slice plus every `scripts/*.sh` it sources. The returned
 * `scanned` is the emitted scope (ADR 0092) — a caller asserts what was read rather than trusting a
 * green, since ZERO scanned files is what a renamed heading looks like.
 */
export const resolveStep55Section = (surface: SkillSurface): ResolvedSection =>
	resolveSection(surface, extractStep55Section);

const shellDefault = (section: string, name: string): number => {
	const m = section.match(new RegExp(`^${name}=\\$\\{[A-Z_]+:-(\\d+)\\}`, "m"));
	return m?.[1] === undefined ? 0 : Number.parseInt(m[1], 10);
};

export const parseReconcileBudget = (surface: SkillSurface): ReconcileBudget => {
	const {section, scanned, unresolved} = resolveStep55Section(surface);
	// ZERO SCOPE and UNRESOLVED are both UNKNOWN, never "the budget is absent" (ADR 0092 / §ZS).
	if (scanned.length === 0 || unresolved.length > 0) return FAILCLOSED_RECONCILE_BUDGET;
	const tries = shellDefault(section, "RECONCILE_TRIES");
	const sleepSeconds = shellDefault(section, "RECONCILE_SLEEP");
	if (tries === 0 || sleepSeconds === 0) return FAILCLOSED_RECONCILE_BUDGET;
	return {
		tries,
		sleepSeconds,
		horizonSeconds: (tries - 1) * sleepSeconds,
		// the guard as the block writes it: `if [ "$i" -lt "$RECONCILE_TRIES" ]; then sleep …`
		sleepsBetweenPollsOnly: /\[\s*"\$i"\s+-lt\s+"\$RECONCILE_TRIES"\s*\][^\n]*sleep/.test(section),
	};
};

/**
 * The `MERGE_DISPOSITION` the skill renders per outcome, keyed by every outcome word its `case`
 * arm lists (`queued|pending` yields two entries pointing at the one shared rendering).
 *
 * This population is **derived from the text**, so it is the one place a relocation could have gone
 * quiet rather than red: a section that reaches no `case` arm yields an EMPTY map, and a consumer
 * that only asserts *properties of* a rendering (`notInclude`, or two renderings differing) passes
 * vacuously on `""`. That is the silent-dropout shape #4509 names. The remedy is not here — a parser
 * cannot know which outcomes exist — it is in the consumer, which pins the expected membership
 * against `MergeOutcome`'s four words so a missing arm reds.
 */
export const parseMergeDispositions = (surface: SkillSurface): ReadonlyMap<string, string> => {
	const {section} = resolveStep55Section(surface);
	const dispositions = new Map<string, string>();
	for (const m of section.matchAll(/^\s*([a-z|]+)\)\s*\n?\s*MERGE_DISPOSITION="([^"]*)"\s*;;/gm)) {
		const [, outcomes, rendering] = m;
		if (outcomes === undefined || rendering === undefined) continue;
		for (const outcome of outcomes.split("|")) dispositions.set(outcome, rendering);
	}
	return dispositions;
};
