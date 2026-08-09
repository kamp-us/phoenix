/**
 * The child body: composed from what the author wrote, then validated through the gate's own readers.
 *
 * Every byte rule below is a v1 scar designed out, and the composition is a **normalization of the
 * authored text**, never a re-rendering of it: the prose under `### What to build` is the author's and
 * survives byte for byte. What the composer fixes is the shape the gate reads — the three field lines
 * consecutive, one blank line before each `###` heading, no blank between `### Acceptance criteria`
 * and its first bullet, a single trailing newline.
 *
 * `**Containment:**` is emitted **only** when the run's cycle-doc read is `present`. v1's documented
 * spec template omitted the field entirely while its skill body required it, so an author following
 * the template dropped it on every child and the tolerant read made "forgot" indistinguishable from
 * "no cycle doc".
 */

import {
	CONTAINMENT_FIELD,
	type Containment,
	fieldLines,
	readChildStories,
	readContainment,
	STORIES_FIELD,
} from "../plan/ledger.ts";
import {read as readAcceptanceCriteria} from "../wire/acceptance-criteria.ts";
import type {CycleDoc} from "./run.ts";

const ACCEPTANCE_CRITERIA = "### Acceptance criteria";

/** The three field-line spellings `fieldLines` recognises, matched here to drop or keep a whole line. */
const fieldLineRe = (field: string): RegExp =>
	new RegExp(
		`^[ \\t]*(?:\\*\\*${field}:\\*\\*|\\*\\*${field}\\*\\*[ \\t]*:|${field}[ \\t]*:)`,
		"i",
	);

const isFieldLine = (line: string): boolean =>
	fieldLineRe("Stories").test(line) ||
	fieldLineRe("TDD").test(line) ||
	fieldLineRe(CONTAINMENT_FIELD).test(line);

/**
 * The authored text with the byte rules applied.
 *
 * Blank lines between consecutive field lines are dropped, every `###` heading is preceded by exactly
 * one blank line, the acceptance-criteria heading is followed directly by its first item, and the
 * result ends in exactly one newline.
 */
export const normalizeChildBody = (text: string, cycleDoc: CycleDoc): string => {
	const dropContainment = cycleDoc !== "present";
	const source = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.filter((line) => !(dropContainment && fieldLineRe(CONTAINMENT_FIELD).test(line)));

	const collapsed: string[] = [];
	for (const line of source) {
		if (line === "" && (collapsed.at(-1) ?? "") === "") continue;
		collapsed.push(line);
	}
	while ((collapsed[0] ?? "x") === "") collapsed.shift();
	while (collapsed.length > 0 && (collapsed.at(-1) ?? "x") === "") collapsed.pop();

	const out: string[] = [];
	for (const [index, line] of collapsed.entries()) {
		if (line === "") {
			const before = out.at(-1) ?? "";
			const after = collapsed[index + 1] ?? "";
			if (isFieldLine(before) && isFieldLine(after)) continue;
			if (before === ACCEPTANCE_CRITERIA) continue;
			out.push(line);
			continue;
		}
		if (line.startsWith("### ") && out.length > 0 && (out.at(-1) ?? "") !== "") out.push("");
		out.push(line);
	}
	return `${out.join("\n")}\n`;
};

export interface ComposedChild {
	readonly _tag: "Composed";
	readonly body: string;
	readonly stories: ReadonlyArray<number> | null;
	readonly containment: Containment | null;
	readonly criteria: number;
}

export type ChildBodyCheck = ComposedChild | {readonly _tag: "Bad"; readonly reason: string};

const bad = (reason: string): ChildBodyCheck => ({_tag: "Bad", reason});

export interface ChildBodyInput {
	readonly text: string;
	readonly cycleDoc: CycleDoc;
	/** The `--type` label the child is born with; only `type:feature` owes a containment value. */
	readonly type: string;
}

/**
 * Compose and validate one child body.
 *
 * The readers are the gate's, imported: a body that composes here cannot fail the gate on grammar.
 * `**Stories:**` carries bare integers or `none` and nothing else — v1 harvested every digit run in
 * the value, so `1, 3 (see #4021)` silently claimed a story 4021 no epic declared.
 */
export const composeChildBody = (input: ChildBodyInput): ChildBodyCheck => {
	const body = normalizeChildBody(input.text, input.cycleDoc);

	for (const field of [STORIES_FIELD, "TDD", CONTAINMENT_FIELD]) {
		const values = fieldLines(body, field);
		if (values.length > 1) {
			return bad(
				`**${field}:** appears ${values.length} times — a child field line has one value, and the gate refuses a duplicate.`,
			);
		}
	}

	const storiesValue = fieldLines(body, STORIES_FIELD)[0];
	const stories = readChildStories(storiesValue);
	if (stories._tag === "NonConforming") {
		return bad(
			`**Stories:** value does not conform: "${stories.value}" — bare integers or "none".`,
		);
	}

	const criteria = readAcceptanceCriteria(body);
	if (criteria._tag !== "Found") {
		return bad(
			`acceptance criteria read as ${criteria._tag === "Absent" ? "absent" : "malformed"} — a child with no checkable criteria is not buildable.`,
		);
	}

	const containmentValue = fieldLines(body, CONTAINMENT_FIELD)[0];
	const containment = readContainment(containmentValue);
	if (input.cycleDoc === "present" && input.type === "type:feature") {
		if (containment !== "flag" && containment !== "exempt") {
			return bad(
				`type:feature child needs **Containment:** flag or exempt — got "${containmentValue ?? ""}", and the cycle doc is present.`,
			);
		}
	}

	return {
		_tag: "Composed",
		body,
		stories: stories._tag === "Ids" ? stories.ids : null,
		containment,
		criteria: criteria.value.length,
	};
};
