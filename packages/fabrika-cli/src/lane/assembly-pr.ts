/**
 * The two pieces of prose an epic run's single assembly PR opens with, derived from the epic issue.
 *
 * The title used to be the literal `feat(epic): #<n> one-PR run`, hardcoded in the operate skill's
 * `gh pr create` fence. The repo squash-merges with `squash_merge_commit_title:
 * COMMIT_OR_PR_TITLE`, so five epics landed on `main` under a subject that is a lane key with no
 * sentence in it. The derivation belongs here rather than in shell expansion because the fence must
 * stay literal, and because the conventional prefix has exactly one home: `feat` comes from
 * `../build/pr-title.ts`, the same read a builder PR's title makes, and this module only stamps the
 * `(epic)` scope over it.
 *
 * The About section's source is the epic's `## Pitch` **Problem** paragraph, read through
 * `../guard/pitch.ts`'s own section reader so a pitch means the same thing here as it does at
 * intake. `../build/pr-body.ts` refuses a body carrying a stray closing keyword or a classification
 * claim, and an epic's Problem paragraph is ordinary prose that may hold either — but the two are
 * not the same problem. A closing keyword acts on GitHub whoever wrote it, so the keyword is
 * swapped. A classification claim is a claim, and that module strips block quotes before it looks
 * for one, for the stated reason that a quotation reproduces text rather than asserting it: so the
 * lifted paragraph lands as a block quote, whole, in the epic's own words. Rewriting `type:epic` to
 * `type epic` instead would leave the assertion standing in the sentence a person reads while the
 * pattern that keys on the colon stops matching — a claim edited into something that only looks
 * safe.
 *
 * The text is bounded to the opening sentences a reader will actually read, and the assembled
 * section is then re-read through `pr-body.ts`'s own predicates, so a section this module answers
 * cannot be one the PR guard refuses.
 */

import {classificationIn, closingTargets, proseOf} from "../build/pr-body.ts";
import {conventionalTitleOf} from "../build/pr-title.ts";
import {PITCH_FIELDS, pitchSection} from "../guard/pitch.ts";

/** The heading the epic reviewer and the founder both read the section under. */
export const ABOUT_HEADING = "## About this epic";

/**
 * The conventional subject's leading `type(scope)!:`, so the scope can be stamped without
 * re-deriving the type. Mirrors `pr-title.ts`'s `CONVENTIONAL_SUBJECT` in shape; it is applied to
 * that module's own output, never to a raw issue title.
 */
const SUBJECT_LEAD = /^([a-z]+)(?:\([^()]*\))?(!?): /;

/**
 * The assembly PR's title: the epic issue's own title under a `feat(epic):` prefix.
 *
 * `feat` is not chosen here — `conventionalTitleOf` maps `type:epic` to it, and that mapping stays
 * the one place release-please's routing rule lives. What this adds is the `(epic)`
 * scope, which is how a reader of `git log` tells an epic's squash from a child's.
 */
export const assemblyTitle = (title: string, labels: ReadonlyArray<string>): string => {
	const subject = conventionalTitleOf(title, labels);
	return subject.replace(SUBJECT_LEAD, "$1(epic)$2: ");
};

/**
 * A pitch field's label line — emphasis-tolerant, and `Problem.` reads like `Problem:`.
 *
 * `pitch.ts` builds the same shape for its own read and admits `:` only. Both separators are live
 * on the board, and a Problem the reader cannot find is an About section nobody gets.
 */
const labelPattern = (field: string): RegExp =>
	new RegExp(
		`^[ \\t]*[*_]{0,2}[ \\t]*${field.replace("-", "[- ]")}[ \\t]*[*_]{0,2}[ \\t]*[.:][ \\t]*[*_]{0,2}[ \\t]*(.*)$`,
		"i",
	);

const PROBLEM_LABEL = labelPattern("Problem");
/** Where the Problem paragraph ends when no blank line does it — a sibling field's own label. */
const FIELD_LABELS = PITCH_FIELDS.map(labelPattern);
const BLANK = /^\s*$/;

/**
 * The `## Pitch` section's **Problem** paragraph — its label line's remainder plus the lines that
 * continue it, up to the first blank line or the next field's label.
 *
 * Whole paragraph rather than `pitch.ts`'s `readField`, which captures one line because the guard
 * only asks whether a field is filled. The About section is prose a person reads, so a Problem
 * wrapped over three lines must arrive whole — and a pitch whose five fields sit on consecutive
 * lines with no blank between them, which is what live epics carry, must not hand the other four
 * over with it.
 */
export const problemParagraph = (body: string): string | null => {
	const section = pitchSection(body);
	if (section === null) return null;
	const lines = section.split(/\r?\n/);
	const start = lines.findIndex((line) => PROBLEM_LABEL.test(line));
	if (start === -1) return null;
	const head = PROBLEM_LABEL.exec(lines[start] ?? "")?.[1] ?? "";
	const rest: Array<string> = [];
	for (const line of lines.slice(start + 1)) {
		if (BLANK.test(line) || FIELD_LABELS.some((label) => label.test(line))) break;
		rest.push(line.trim());
	}
	const paragraph = [head.trim(), ...rest].join(" ").trim();
	return paragraph === "" ? null : paragraph;
};

/** GitHub's auto-closing keywords followed by an issue reference — `pr-body.ts`'s `CLOSING_RE`. */
const CLOSING_REF = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+#\d+)\b/gi;

/**
 * A closing keyword's replacement, per keyword form so the sentence keeps its tense.
 *
 * The keyword is what GitHub links on — its "Linking a pull request to an issue using a keyword"
 * page gives the syntax as `KEYWORD #ISSUE-NUMBER` over a closed list of nine keywords
 * (https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).
 * None of the six words below is on that list, so the rewritten sentence carries no link — a
 * positive read of the documented syntax rather than a claim about a form the page is silent on.
 * The issue reference itself is left exactly as written, so the reader still lands on it.
 */
const KEYWORD_SWAP: Readonly<Record<string, string>> = {
	close: "settle",
	closes: "settles",
	closed: "settled",
	fix: "repair",
	fixes: "repairs",
	fixed: "repaired",
	resolve: "settle",
	resolves: "settles",
	resolved: "settled",
};

const swapKeyword = (word: string): string => {
	const swap = KEYWORD_SWAP[word.toLowerCase()] ?? word;
	return word[0] === word[0]?.toUpperCase() ? `${swap[0]?.toUpperCase()}${swap.slice(1)}` : swap;
};

/**
 * The paragraph with every closing keyword swapped for a word GitHub's list does not carry. The
 * `#<n>` each aimed at is untouched, so the reader still lands on the issue.
 *
 * This is the one rewrite the module makes, and it is not an edit to a claim: a closing keyword acts
 * on GitHub whatever the sentence around it means, and disarming it changes what the body *does*
 * rather than what it says. A classification claim is the opposite case and is quoted, not reworded.
 */
const swapClosingKeywords = (text: string): string =>
	text.replace(CLOSING_REF, (_m, verb: string, ref: string) => `${swapKeyword(verb)}${ref}`);

/**
 * How much of a Problem paragraph the About section lifts: whole sentences, up to this many words.
 *
 * The hand-written sections this derivation replaces run two to four sentences. Live epics do not:
 * a Problem paragraph is a triage surface and routinely runs three hundred words of file paths and
 * SDK line numbers, which as an opening section is a wall nobody reads. The first sentence always
 * survives whole — a bound that can empty the section is worse than a long one.
 */
const ABOUT_WORD_BUDGET = 60;
const ABOUT_SENTENCE_CAP = 4;

/** A sentence ends on `.`/`!`/`?` followed by space — a period inside `file.ts` has no space after. */
const SENTENCE_END = /(?<=[.!?])\s+/;

const wordsIn = (text: string): number => text.split(/\s+/).filter((w) => w !== "").length;

/** The paragraph's opening sentences, and `…` when the bound left any of it behind. */
export const boundedParagraph = (paragraph: string): string => {
	const sentences = paragraph.split(SENTENCE_END).filter((s) => s.trim() !== "");
	const kept = [sentences[0] ?? paragraph];
	let words = wordsIn(kept[0] ?? "");
	for (const sentence of sentences.slice(1, ABOUT_SENTENCE_CAP)) {
		const next = words + wordsIn(sentence);
		if (next > ABOUT_WORD_BUDGET) break;
		kept.push(sentence);
		words = next;
	}
	const text = kept.join(" ").trim();
	return kept.length === sentences.length ? text : `${text} […]`;
};

/** Every line under `> ` — the shape `proseOf` drops as reproduced text rather than an assertion. */
const quoted = (text: string): string =>
	text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");

export type AboutRead =
	/** The section, ready to interpolate. */
	| {readonly _tag: "Section"; readonly text: string}
	/** No `## Pitch`, or a pitch whose Problem paragraph is missing or empty. */
	| {readonly _tag: "Unpitched"; readonly why: string}
	/** The assembled section is one the PR guard would refuse, and the reason is named. */
	| {readonly _tag: "Unsafe"; readonly what: string};

/**
 * The epic's About section, or the one reason there is none.
 *
 * The verification is `pr-body.ts`'s own readers, so the answer is not "this looks safe" but "the
 * guard's predicates were run over it". Both reads should be empty by construction, and that is the
 * point: they are what keeps the swap list matched to `CLOSING_RE` and the quoting intact as this
 * module changes, rather than leaving either to be noticed at a refused `build pr`.
 */
export const aboutSection = (epic: number, body: string): AboutRead => {
	const problem = problemParagraph(body);
	if (problem === null) {
		return {
			_tag: "Unpitched",
			why:
				pitchSection(body) === null
					? "carries no `## Pitch` section"
					: "carries a `## Pitch` with no Problem paragraph",
		};
	}
	const lifted = boundedParagraph(swapClosingKeywords(problem));
	const text = `${ABOUT_HEADING}\n\n${quoted(`Epic #${epic}: ${lifted}`)}\n`;

	// The two reads differ here and nowhere else: the closing check is over the unquoted text,
	// because `proseOf` would drop the block quote and with it the keyword being checked for.
	const stray = closingTargets(lifted)[0];
	if (stray !== undefined) {
		return {_tag: "Unsafe", what: `a closing keyword aimed at #${stray}`};
	}
	// Over the assembled section, where everything lifted is quoted — so this reads whether the
	// quoting held, not whether the epic's own sentence mentions a label.
	const claim = classificationIn(proseOf(text));
	return claim === null
		? {_tag: "Section", text}
		: {_tag: "Unsafe", what: `a ${claim} classification claim`};
};
