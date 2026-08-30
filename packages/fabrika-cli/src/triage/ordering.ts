/**
 * Does a body **state** an ordering — "do not start until #N" — and which issues does it name?
 *
 * ADR 0301 makes the native `blocked_by` graph the one carrier of "do not start this yet", and the
 * founder ruling at
 * https://github.com/kamp-us/phoenix/issues/6728#issuecomment-5465597763 makes `triage enrich`
 * fail-closed against a body that states an ordering the graph carries no edge for. This module is
 * the reading half of that: the writing half is `--blocked-by` in `./blocked-by.ts`.
 *
 * **The phrase must bind the reference; co-presence is not a statement.** A line carrying an
 * ordering word *somewhere* and a `#N` *somewhere* matches an issue that merely writes ABOUT
 * orderings — #6728's own body says "Searched the queue and open issues for ordering/edge/blocked
 * work. #6734, #6730, #6722 and #6715 are all live fabrika gate defects", which names no
 * prerequisite at all. That red could not be cleared by wiring an edge, so it would leave the
 * caller with only the reword escape for a body that is already correct.
 *
 * **Quotations are mentions.** An inline-code span or a double-quoted span is somebody else's
 * words being reported, which is why the scan reads a line with those spans blanked — #6728 quotes
 * #6663's `"**Blocked. Do not start until #6662 has merged**"` while stating no ordering of its own.
 *
 * **A third-person subject is somebody else's prerequisite.** A body states its own ordering as
 * "Blocked on #N"; "it is already blocked on #N" is a report about another issue, and no edge on
 * *this* issue could ever clear it. #7238 says verbatim "Not folded into #7223: its criteria are
 * scoped to … and it is already blocked on #7035" and owns no prerequisite at all (#6728 round 1).
 *
 * Both narrowings trade a missed red for a red nobody can clear, and that trade is the right one
 * here because the refusal has **no override**: a false negative leaves an issue the old, pre-gate
 * world already tolerated, while a false red strands a correct body on the reword escape.
 */
import {contractRegionLines} from "../wire/acceptance-criteria.ts";

/** One line of a body that states an ordering, and the issues that ordering names. */
export interface StatedOrdering {
	/** 1-based, so a refusal can point at a line a human can find. */
	readonly line: number;
	/** The line as written, quotations intact — what the refusal quotes back. */
	readonly text: string;
	/** Every `#N` at or after the ordering phrase, in order, deduplicated. */
	readonly references: ReadonlyArray<number>;
}

/**
 * The closed set of ordering phrases, each anchored to the reference it binds.
 *
 * Closed and short on purpose: every phrase added here is a new way for a body that owns no
 * prerequisite to be refused, and the refusal has no override. The four families are the ones the
 * ruling names — `blocked …`, `do not start until …`, `depends on …`, `order is …`.
 */
const ORDERING_PHRASES: ReadonlyArray<RegExp> = [
	/\bblocked\s+(?:by|on|until|behind)\s+(?:the\s+)?(?:issue\s+|pr\s+)?#\d+/i,
	/\bdo(?:\s+not|n['’]t)\s+start\s+(?:until|before)\s+(?:the\s+)?(?:issue\s+|pr\s+)?#\d+/i,
	/\bdepends?\s+on\s+(?:the\s+)?(?:issue\s+|pr\s+)?#\d+/i,
	/\bdependent\s+on\s+(?:the\s+)?(?:issue\s+|pr\s+)?#\d+/i,
	/\border\s+is\b[^.]*#\d+/i,
];

const REFERENCE = /#(\d+)/g;

/**
 * Blank the spans a line is reporting rather than asserting, keeping its length so the phrase
 * offsets found in the blanked line still index the line as written.
 */
const blankQuotations = (text: string): string =>
	text
		.replace(/`[^`]*`/g, (span) => " ".repeat(span.length))
		.replace(/"[^"]*"/g, (span) => " ".repeat(span.length))
		.replace(/“[^”]*”/g, (span) => " ".repeat(span.length));

/**
 * The sentence the ordering phrase opens, so a reference in the *next* sentence is not read as one
 * of its targets — "blocked by #6661. Separately, #6734 is a different defect" names one.
 */
const sentenceFrom = (text: string, start: number): string => {
	const end = text.indexOf(". ", start);
	return end === -1 ? text.slice(start) : text.slice(start, end);
};

/**
 * A bare third-person pronoun in the subject seat, optionally trailed by a copula and its adverbs.
 *
 * `this` is deliberately absent: "This work is blocked until #N" is a body naming itself, while
 * "it is blocked on #N" is a body naming something it just mentioned.
 */
const THIRD_PERSON_SUBJECT =
	/\b(?:it|its|they|their|which|that)\b(?:\s+(?:is|are|was|were|remains?|stays?|already|still|now|therefore))*\s*$/i;

/** Does the text running up to the phrase hand its subject to somebody other than this issue? */
const attributedElsewhere = (text: string, start: number): boolean => {
	const before = text.slice(0, start);
	const sentence = before.slice(before.lastIndexOf(". ") + 1);
	return THIRD_PERSON_SUBJECT.test(sentence);
};

/** Where the earliest ordering phrase starts on this line, or `null` if none binds a reference. */
const phraseStart = (text: string): number | null => {
	let earliest: number | null = null;
	for (const phrase of ORDERING_PHRASES) {
		const match = phrase.exec(text);
		if (match === null) continue;
		if (earliest === null || match.index < earliest) earliest = match.index;
	}
	return earliest;
};

/**
 * Every stated ordering in `text`'s contract region.
 *
 * References are collected from the ordering phrase's own sentence rather than from the whole line —
 * "unlike #6734, this depends on #6661" names one prerequisite, not two — and a blockquote line is
 * skipped for the same reason a quoted span is.
 */
export const statedOrderings = (text: string): ReadonlyArray<StatedOrdering> => {
	const found: StatedOrdering[] = [];
	for (const {line, text: raw} of contractRegionLines(text.split("\n"))) {
		if (/^ {0,3}>/.test(raw)) continue;
		const readable = blankQuotations(raw);
		const start = phraseStart(readable);
		if (start === null) continue;
		if (attributedElsewhere(readable, start)) continue;
		const references = new Set<number>();
		for (const match of sentenceFrom(readable, start).matchAll(REFERENCE)) {
			references.add(Number(match[1]));
		}
		found.push({line, text: raw, references: [...references]});
	}
	return found;
};

/**
 * The issues a body's stated orderings name that the live `blocked_by` set does not carry.
 *
 * A number the graph already carries is not reported: the whole point of the gate is that stating an
 * ordering and wiring it agree, so a wired one is the passing case.
 */
export const unwiredReferences = (
	orderings: ReadonlyArray<StatedOrdering>,
	live: ReadonlyArray<number>,
): ReadonlyArray<StatedOrdering> =>
	orderings
		.map((ordering) => ({
			...ordering,
			references: ordering.references.filter((number) => !live.includes(number)),
		}))
		.filter((ordering) => ordering.references.length > 0);
