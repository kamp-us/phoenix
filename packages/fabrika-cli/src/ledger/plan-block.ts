/**
 * The plan block's grammar: the closed section set and the story list, checked before anything is
 * staged.
 *
 * The check is total over *shape* and says nothing about content — a `### Approach` reading "TBD"
 * stages cleanly, and catching that is the skill's job, not a verb's. What it does catch is the class
 * an author cannot see: `readEpicStories` collects ids only from ordered-list rows, so a
 * `### User stories` section full of `-` bullets or `S1`-style labels parses as **zero stories** while
 * looking complete. The gate's floor then reds `MISSING_STORIES_SECTION` over the whole epic — a
 * planner writing a plan its own gate rejects, which is the failure this group exists to prevent.
 *
 * The section presence and duplication counts come from the gate's own `sectionCount`, so the composer
 * is held to the reader it is composing for. Only the *ordering* is derived here, because no shipped
 * reader answers it.
 */

import {readEpicStories, sectionCount, unfencedLines} from "../plan/ledger.ts";

/** The line the block must open with. */
export const PLAN_HEADING = "## Plan (plan-epic)";

/** The closed section set: each present exactly once, in this order. */
export const PLAN_SECTIONS: ReadonlyArray<string> = [
	"Summary",
	"Problem & who has it",
	"What changes",
	"User stories",
	"Goal / non-goals",
	"Resolved questions",
	"Approach",
	"Testing strategy",
	"Task-split rationale",
	"Vocabulary impact",
];

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The `###` headings the block carries, in the order they appear, outside every fence. */
const headingOrder = (text: string): ReadonlyArray<string> => {
	const seen: string[] = [];
	for (const {text: line} of unfencedLines(text)) {
		const matched = ATX_HEADING.exec(line);
		if (matched?.[1] === undefined || matched[2] === undefined) continue;
		if (matched[1].length !== 3) continue;
		seen.push(normalize(matched[2]));
	}
	return seen;
};

export type PlanBlockCheck =
	| {
			readonly _tag: "Ok";
			readonly sections: number;
			readonly stories: ReadonlyArray<number>;
	  }
	| {readonly _tag: "Bad"; readonly reason: string};

const bad = (reason: string): PlanBlockCheck => ({_tag: "Bad", reason});

/**
 * Check the authored plan block. Every `Bad` names exactly one correctable thing, so a second attempt
 * is a correction rather than a rewrite.
 */
export const checkPlanBlock = (text: string): PlanBlockCheck => {
	const opening = text.split("\n").find((line) => line.trim() !== "");
	if (opening?.trim() !== PLAN_HEADING) {
		return bad(`the plan block does not open with "${PLAN_HEADING}".`);
	}

	const missing = PLAN_SECTIONS.filter((heading) => sectionCount(text, heading) === 0);
	if (missing.length > 0) {
		return bad(`the plan block is missing section(s): ${missing.join(", ")}.`);
	}
	for (const heading of PLAN_SECTIONS) {
		const count = sectionCount(text, heading);
		if (count > 1) {
			return bad(
				`the plan block carries ${count} "${heading}" sections — a plan with two of one section has no single meaning.`,
			);
		}
	}

	const wanted = PLAN_SECTIONS.map(normalize);
	const seen = headingOrder(text).filter((key) => wanted.includes(key));
	for (let i = 1; i < seen.length; i += 1) {
		const previous = seen[i - 1];
		const current = seen[i];
		if (previous === undefined || current === undefined) continue;
		if (wanted.indexOf(current) < wanted.indexOf(previous)) {
			const label = (key: string) => PLAN_SECTIONS[wanted.indexOf(key)] ?? key;
			return bad(
				`the plan block's sections are out of order: "${label(current)}" appears after "${label(previous)}".`,
			);
		}
	}

	const stories = readEpicStories(text);
	if (stories._tag === "MisNumbered") {
		return bad(
			`user stories are numbered ${stories.ids.join(", ")} — a story list must run from 1 with no gaps or repeats.`,
		);
	}
	if (stories.ids.length === 0) {
		return bad(
			'the plan declares zero user stories — an ordered list is what carries them, and a bullet or an "S<n>" label parses as none.',
		);
	}

	return {_tag: "Ok", sections: PLAN_SECTIONS.length, stories: stories.ids};
};
