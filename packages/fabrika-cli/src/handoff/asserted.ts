/**
 * The asserted half a caller supplies on stdin: exactly four sections, in order, each non-empty.
 *
 * <!-- anchor: THE-SECTION-SET-IS-CLOSED --> **Content outside those headings is refused, not
 * ignored.** A fifth heading or prose before the first one is the injection this format defends
 * against: an open section set lets an author append a paragraph a successor reads as part of the
 * format, and the successor has no way to tell the format's own words from someone else's.
 *
 * <!-- anchor: UNSURE-IS-NEVER-SILENT --> **An empty section is a refusal.** A section skipped and a
 * section with nothing to say are the same bytes and opposite facts, so the format refuses to
 * represent the ambiguity; `## Unsure` is the row this exists for — a successor reads an empty
 * `Unsure` as certainty.
 *
 * The caller supplies only these four. The proven half is appended by the verb from its own fresh
 * capture, because a caller-supplied ground state would be exactly the premise-inheritance (#4133)
 * the two-half split exists to prevent.
 */

import {ASSERTED_SECTIONS} from "../wire/handoff-pack.ts";

export interface AssertedHalf {
	readonly intent: string;
	readonly established: string;
	readonly nextAct: string;
	readonly unsure: string;
}

export type AssertedProblem =
	/** A heading the format does not own, or text under none — the closed-set refusal. */
	| {readonly _tag: "Outside"; readonly heading: string}
	/** One named section carries nothing. Its own case so `## Unsure` can name its own remedy. */
	| {readonly _tag: "Empty"; readonly heading: string}
	/** The four are not all present, in order. */
	| {readonly _tag: "Shape"; readonly detail: string};

export type AssertedParse =
	| {readonly _tag: "Asserted"; readonly value: AssertedHalf}
	| {readonly _tag: "Problem"; readonly problem: AssertedProblem};

const HEADING = /^##\s+(.*\S)\s*$/;

export const parseAsserted = (text: string): AssertedParse => {
	const sections: {name: string; lines: string[]}[] = [];
	let stray: string | null = null;
	for (const raw of text.split("\n")) {
		const heading = HEADING.exec(raw);
		if (heading?.[1] !== undefined) {
			sections.push({name: heading[1], lines: []});
			continue;
		}
		const current = sections.at(-1);
		if (current === undefined) {
			if (raw.trim() !== "" && stray === null) stray = raw.trim();
			continue;
		}
		current.lines.push(raw);
	}

	if (stray !== null) return {_tag: "Problem", problem: {_tag: "Outside", heading: stray}};
	const unknown = sections.find(
		(section) => !(ASSERTED_SECTIONS as ReadonlyArray<string>).includes(section.name),
	);
	if (unknown !== undefined) {
		return {_tag: "Problem", problem: {_tag: "Outside", heading: `## ${unknown.name}`}};
	}
	const names = sections.map((section) => section.name);
	if (names.join(" ") !== ASSERTED_SECTIONS.join(" ")) {
		return {
			_tag: "Problem",
			problem: {
				_tag: "Shape",
				detail: `expected ${ASSERTED_SECTIONS.map((name) => `## ${name}`).join(", ")}, in that order; found ${
					names.length === 0 ? "no section at all" : names.map((name) => `## ${name}`).join(", ")
				}`,
			},
		};
	}
	const empty = sections.find((section) => section.lines.join("\n").trim() === "");
	if (empty !== undefined) {
		return {_tag: "Problem", problem: {_tag: "Empty", heading: `## ${empty.name}`}};
	}

	const [intent, established, nextAct, unsure] = sections;
	if (
		intent === undefined ||
		established === undefined ||
		nextAct === undefined ||
		unsure === undefined
	) {
		// Unreachable: the order check above already proved all four are present.
		return {_tag: "Problem", problem: {_tag: "Shape", detail: "the asserted half is incomplete"}};
	}
	const body = (section: {lines: ReadonlyArray<string>}): string => section.lines.join("\n").trim();
	return {
		_tag: "Asserted",
		value: {
			intent: body(intent),
			established: body(established),
			nextAct: body(nextAct),
			unsure: body(unsure),
		},
	};
};
