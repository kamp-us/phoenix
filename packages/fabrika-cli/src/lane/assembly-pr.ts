/**
 * The two pieces of prose an epic run's single assembly PR opens with, derived from the epic issue.
 *
 * The title used to be the literal `feat(epic): #<n> one-PR run`, hardcoded in the operate skill's
 * `gh pr create` fence. The repo squash-merges with `squash_merge_commit_title:
 * COMMIT_OR_PR_TITLE`, so five epics landed on `main` under a subject that is a lane key with no
 * sentence in it (#8201). The derivation belongs here rather than in shell expansion because the
 * fence must stay literal, and because the conventional prefix has exactly one home: `feat` comes
 * from `../build/pr-title.ts`, the same read a builder PR's title makes, and this module only
 * stamps the `(epic)` scope over it.
 *
 * The About section's source is the epic's `## Pitch` **Problem** paragraph, read through
 * `../guard/pitch.ts`'s own section reader so a pitch means the same thing here as it does at
 * intake. It is never passed through raw: `../build/pr-body.ts` refuses a body carrying a stray
 * closing keyword or a classification claim, and an epic's Problem paragraph is ordinary prose that
 * may hold either. So the text is neutralised mechanically and then re-read through that module's
 * own predicates — a section this module answers cannot be one the PR guard refuses, and text it
 * cannot make safe is refused here rather than shipped.
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
 * the one place release-please's routing rule lives (#6754, #5771). What this adds is the `(epic)`
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
const CLOSING_REF = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+)#(\d+)\b/gi;
/** A `type:<label>` quoted in prose — `pr-body.ts` reads one as a classification claim. */
const TYPE_CLAIM = /\btype:([a-z]+)\b/gi;
/** A bare priority token, in the exact shape `pr-body.ts` reads as a claim. */
const PRIORITY_CLAIM = /(^|\s)(p[0-3])(?=\s|$|[.,;:!?])/gi;

/**
 * The paragraph with the two shapes the PR guard refuses rewritten into ones it does not, each
 * rewrite keeping every word:
 *
 * - a closing keyword's `#<n>` becomes that issue's URL, which GitHub does not auto-close on and a
 *   reader still follows;
 * - a `type:<x>` loses its colon and a bare `p<n>` gains backticks, both of which break the guard's
 *   patterns at the character the pattern keys on.
 *
 * `control-plane` has no such rewrite — the phrase itself is the claim — so it falls through to the
 * verification below and refuses. That is the intended floor: a claim about a gated question is
 * never edited into something that only looks safe.
 */
const neutralise = (text: string, repo: string): string =>
	text
		.replace(
			CLOSING_REF,
			(_m, verb: string, gap: string, number: string) =>
				`${verb}${gap}https://github.com/${repo}/issues/${number}`,
		)
		.replace(TYPE_CLAIM, "type $1")
		.replace(PRIORITY_CLAIM, "$1`$2`");

export type AboutRead =
	/** The section, ready to interpolate. */
	| {readonly _tag: "Section"; readonly text: string}
	/** No `## Pitch`, or a pitch whose Problem paragraph is missing or empty. */
	| {readonly _tag: "Unpitched"; readonly why: string}
	/** The neutralised text still asserts something the PR guard refuses, and it is named. */
	| {readonly _tag: "Unsafe"; readonly what: string};

/**
 * The epic's About section, or the one reason there is none.
 *
 * The verification is `pr-body.ts`'s own readers over `proseOf` — the same three calls the guard
 * makes — so the answer is not "this looks safe" but "the guard's predicates were run over it".
 */
export const aboutSection = (epic: number, body: string, repo: string): AboutRead => {
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
	const text = `${ABOUT_HEADING}\n\nEpic #${epic}: ${neutralise(problem, repo)}\n`;
	const prose = proseOf(text);
	const stray = closingTargets(prose)[0];
	if (stray !== undefined) {
		return {_tag: "Unsafe", what: `a closing keyword aimed at #${stray}`};
	}
	const claim = classificationIn(prose);
	return claim === null
		? {_tag: "Section", text}
		: {_tag: "Unsafe", what: `a ${claim} classification claim`};
};
