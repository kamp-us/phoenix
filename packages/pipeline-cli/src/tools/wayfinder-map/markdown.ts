/**
 * Tolerant markdown parsing for the four `wayfinder:map` sections the validator
 * reads: `## Destination`, `## Decisions-so-far`, `## Open frontier`, and
 * `## Graduated fog`. Per the formats contract these are conventions to read
 * tolerantly, not parser specs — recognize a section by its heading shape
 * (case-insensitive, punctuation-flexible), not by exact whitespace. Parsing is
 * pure and deterministic: the same body always yields the same `WayfinderMap`,
 * with entries emitted in document order.
 *
 * See `gh-issue-intake-formats.md` §The `wayfinder:map` issue shape for the four
 * sections and the worked example these regexes are calibrated against.
 */
import type {Decision, FogEntry, FrontierTicket, WayfinderMap} from "./Map.ts";

/** Any markdown ATX heading line. */
const ANY_HEADING = /^#{1,6}\s+\S/;

/** An unordered-list item line: `- …`, `* …`, `+ …`. */
const LIST_ITEM = /^\s*[-*+]\s+(\S.*)$/;

const ISSUE_REF = /#(\d+)/g;

/**
 * The four canonical section headings, tolerant of casing and of the punctuation
 * drift the field-notes rule sanctions (`Decisions-so-far` / `Decisions so far`,
 * `Graduated-fog` / `Graduated fog`).
 */
const DESTINATION_HEADING = /^#{1,6}\s+destination\b/i;
const DECISIONS_HEADING = /^#{1,6}\s+decisions?[-\s]+so[-\s]+far\b/i;
const FRONTIER_HEADING = /^#{1,6}\s+open[-\s]+frontier\b/i;
const FOG_HEADING = /^#{1,6}\s+graduated[-\s]+fog\b/i;

/** A `founder-decision-fork` flag anywhere on a frontier line (formats §Open frontier). */
const FOUNDER_FORK = /founder[-\s]decision[-\s]fork/i;

/** A decision line's `— from #N` attribution; captures the origin issue (group 1). */
const FROM_REF = /\bfrom\s+#(\d+)/i;

/** A fog line's `→ spawned #M` follow-on refs; each match captures the spawned issue. */
const SPAWNED_REF = /spawned\s+#(\d+)/gi;

const headingLevel = (line: string): number => {
	const match = /^(#{1,6})\s/.exec(line);
	return match?.[1] ? match[1].length : 0;
};

const firstIssueRef = (text: string): number | undefined => {
	const match = /#(\d+)/.exec(text);
	return match?.[1] ? Number(match[1]) : undefined;
};

interface Section {
	readonly present: boolean;
	/** The section's lines, heading excluded — empty when absent or empty. */
	readonly lines: ReadonlyArray<string>;
}

/**
 * Slice the first section whose heading matches `headingRe` out of a body: every
 * line after the heading up to the next heading of the same or higher level. An
 * absent heading yields `{present: false, lines: []}` — read by the validator as
 * the section's `MISSING_*` defect.
 */
const sliceSection = (body: string, headingRe: RegExp): Section => {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => headingRe.test(line));
	if (start === -1) return {present: false, lines: []};
	const level = headingLevel(lines[start] ?? "");
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (ANY_HEADING.test(line) && headingLevel(line) <= level) break;
		out.push(line);
	}
	return {present: true, lines: out};
};

/** The list-item bodies (text after the bullet) of a section, in document order. */
const listItems = (section: Section): ReadonlyArray<string> => {
	const items: string[] = [];
	for (const line of section.lines) {
		const match = LIST_ITEM.exec(line);
		if (match?.[1]) items.push(match[1].trim());
	}
	return items;
};

const parseDestination = (body: string): WayfinderMap["destination"] => {
	const section = sliceSection(body, DESTINATION_HEADING);
	const text = section.lines
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join(" ")
		.trim();
	return {present: section.present, text};
};

const parseDecisions = (body: string): {present: boolean; entries: ReadonlyArray<Decision>} => {
	const section = sliceSection(body, DECISIONS_HEADING);
	const entries = listItems(section).map((text): Decision => {
		const match = FROM_REF.exec(text);
		return match?.[1] ? {text, fromIssue: Number(match[1])} : {text};
	});
	return {present: section.present, entries};
};

const parseFrontier = (
	body: string,
): {present: boolean; entries: ReadonlyArray<FrontierTicket>} => {
	const section = sliceSection(body, FRONTIER_HEADING);
	const entries = listItems(section).map(
		(question): FrontierTicket => ({
			issue: firstIssueRef(question),
			question,
			founderDecisionFork: FOUNDER_FORK.test(question),
		}),
	);
	return {present: section.present, entries};
};

const collectSpawned = (text: string): ReadonlyArray<number> => {
	const refs: number[] = [];
	for (const match of text.matchAll(SPAWNED_REF)) {
		if (match[1]) refs.push(Number(match[1]));
	}
	return [...new Set(refs)].sort((a, b) => a - b);
};

const parseFog = (body: string): {present: boolean; entries: ReadonlyArray<FogEntry>} => {
	const section = sliceSection(body, FOG_HEADING);
	const entries = listItems(section).map((note): FogEntry => {
		// The graduated issue is the FIRST ref on the line; `spawned #M` refs are
		// follow-on frontier, captured separately, so a line's own subject is never
		// confused with what it spawned.
		const spawned = new Set(collectSpawned(note));
		const allRefs: number[] = [];
		for (const match of note.matchAll(ISSUE_REF)) allRefs.push(Number(match[1]));
		const issue = allRefs.find((n) => !spawned.has(n)) ?? allRefs[0];
		return {issue, note, spawned: [...spawned].sort((a, b) => a - b)};
	});
	return {present: section.present, entries};
};

/**
 * Parse a `wayfinder:map` issue body into a structured `WayfinderMap`. Every
 * section is sliced tolerantly and lowered to structured entries; an absent
 * section is recorded as `present: false` (its `MISSING_*` defect), never thrown
 * on. The result is pure data — `validateMap` and `isGraduationReady` run over it
 * without ever touching markdown again.
 */
export const parseMapBody = (body: string): WayfinderMap => ({
	destination: parseDestination(body),
	decisionsSoFar: parseDecisions(body),
	openFrontier: parseFrontier(body),
	graduatedFog: parseFog(body),
});
