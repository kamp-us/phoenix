/**
 * Where the plan goes in the epic body, resolved by anchors rather than by position.
 *
 * **Detection is the verb-written enrichment marker, never a position** (#4850, #4866): with the
 * marker doing the detecting, appending the plan below the preserved brief envelope breaks no
 * detector, so no layout inversion is needed. What the marker buys here is the *bound*: a
 * `## Dependencies` heading that resolves **inside** the preserved brief is not this run's anchor, and
 * cutting there is how v1 destroyed a body (#4879).
 *
 * **The region is never cut to end-of-file.** v1's replace branch sliced from the `## Dependencies`
 * heading to EOF on the assumption that dependencies are the last section, destroying anything a human
 * had appended below with no guard at all. This module resolves a bounded region and preserves every
 * byte outside it.
 */

import {unfencedLines} from "../plan/ledger.ts";
import {MARKER_RE} from "../triage/enrich.ts";
import {PLAN_HEADING} from "./plan-block.ts";
import type {PlanMode} from "./run.ts";

export const DEPENDENCIES_HEADING = "## Dependencies";

const PLAN_RE = /^##\s+Plan\s+\(plan-epic\)\s*$/;
const DEPENDENCIES_RE = /^##\s+Dependencies\s*$/;
const TOP_LEVEL_HEADING_RE = /^#{1,2}\s+/;

/** 0-based indices into the body's lines, for the unfenced lines matching `pattern`. */
const anchorsIn = (body: string, pattern: RegExp): ReadonlyArray<number> =>
	unfencedLines(body)
		.filter(({text}) => pattern.test(text.trim()))
		.map(({line}) => line - 1);

export type Splice =
	| {readonly _tag: "Composed"; readonly body: string}
	| {readonly _tag: "Unresolvable"; readonly reason: string};

const unresolvable = (reason: string): Splice => ({_tag: "Unresolvable", reason});

const headingCount = (epic: number, heading: string, count: number): string =>
	`#${epic}'s body carries ${count} "${heading}" headings — the plan region has no single meaning.`;

/** The `[start, end)` line span of the preserved brief envelope, or `null` when there is no marker. */
const envelopeOf = (lines: ReadonlyArray<string>): {start: number; end: number} | null => {
	const start = lines.findIndex((line) => MARKER_RE.test(line.trim()));
	if (start === -1) return null;
	const closing = lines.findIndex(
		(line, index) => index > start && line.trim().toLowerCase() === "</details>",
	);
	return {start, end: closing === -1 ? start : closing};
};

export interface SpliceInput {
	readonly epic: number;
	readonly body: string;
	readonly mode: PlanMode;
	/** The staged plan block, opening with `## Plan (plan-epic)`. */
	readonly plan: string;
	/** The staged `## Dependencies` block. */
	readonly topology: string;
}

const block = (text: string): string => text.replace(/\s+$/, "");

/**
 * Resolve the region and produce the whole new body.
 *
 * `mode` is carried from `ledger open`, never re-derived here: a `write` that recomputed it from the
 * live body could disagree with the `open` that named the run, which is precisely how the
 * mode-mismatch arm becomes unreachable and a first-time append silently overwrites a real plan.
 */
export const splicePlan = (input: SpliceInput): Splice => {
	const lines = input.body.replace(/\r\n/g, "\n").split("\n");
	const planAnchors = anchorsIn(input.body, PLAN_RE);
	const composed = `${block(input.plan)}\n\n${block(input.topology)}\n`;

	if (input.mode === "fresh") {
		if (planAnchors.length > 0) {
			return unresolvable(headingCount(input.epic, PLAN_HEADING, planAnchors.length));
		}
		return {_tag: "Composed", body: `${block(input.body)}\n\n${composed}`};
	}

	if (planAnchors.length === 0) {
		return unresolvable(
			`mode is re-plan and the body carries no "${PLAN_HEADING}" heading — the anchor drifted or was deleted.`,
		);
	}
	if (planAnchors.length > 1) {
		return unresolvable(headingCount(input.epic, PLAN_HEADING, planAnchors.length));
	}

	const dependencyAnchors = anchorsIn(input.body, DEPENDENCIES_RE);
	if (dependencyAnchors.length !== 1) {
		return unresolvable(headingCount(input.epic, DEPENDENCIES_HEADING, dependencyAnchors.length));
	}

	const start = planAnchors[0] as number;
	const dependencies = dependencyAnchors[0] as number;
	const envelope = envelopeOf(lines);
	if (envelope !== null && dependencies > envelope.start && dependencies < envelope.end) {
		return unresolvable(
			`#${input.epic}'s "${DEPENDENCIES_HEADING}" heading resolves inside the preserved brief envelope — refusing to cut the region there (#4879).`,
		);
	}
	if (dependencies < start) {
		return unresolvable(
			`#${input.epic}'s "${DEPENDENCIES_HEADING}" heading sits above its "${PLAN_HEADING}" heading — the plan region has no single meaning.`,
		);
	}

	let end = lines.length;
	for (let i = dependencies + 1; i < lines.length; i += 1) {
		if (TOP_LEVEL_HEADING_RE.test((lines[i] ?? "").trim())) {
			end = i;
			break;
		}
	}

	const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
	const after = lines.slice(end).join("\n").replace(/^\n+/, "");
	const head = before === "" ? "" : `${before}\n\n`;
	const tail = after.trim() === "" ? "" : `\n${after}`;
	return {_tag: "Composed", body: `${head}${composed}${tail}`};
};
