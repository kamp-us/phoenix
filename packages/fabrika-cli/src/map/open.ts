/**
 * `map open`'s pure half: what counts as a question, what the map's title reads as, and how a
 * destination is ranked against what is already charted.
 *
 * <!-- anchor: THE-GATE-IS-EVIDENCE-NOT-VERDICT --> **This is the fog-or-ticket test's checkable
 * half, and deliberately not the whole test.** Whether something is genuinely fog is a judgment the
 * skill carries; what a verb can prove is that the caller enumerated questions, that nobody has
 * charted or rejected this destination already. That is what makes a wrong classification catchable
 * at the point it is made rather than well-formed and wrong (#4227) — the claim is bound to an
 * enumerable artifact instead of to the caller's confidence. It is **not** a second answer to ADR
 * 0203's fog-versus-buildable discriminator, which is seated at intake and expected here.
 */

import {rank, scoreTitle, TOKEN_FLOOR, tokenize} from "../report/dedup.ts";

/** The prefix every map title carries, so the label and the title agree about what an issue is. */
export const TITLE_PREFIX = "wayfinding: ";
/** GitHub's practical title ceiling; the destination is cut to fit on a word boundary. */
export const TITLE_LIMIT = 250;

/**
 * The interrogatives a question may open with, when it does not close with `?`.
 *
 * A closed set rather than a heuristic: this is a **grammar** check on the input document, which is
 * what makes `17` provable. The verb is not deciding that the destination is a deliverable, it is
 * reporting that nothing it was handed was *stated* as a question.
 */
const INTERROGATIVES = new Set([
	"what",
	"who",
	"when",
	"where",
	"why",
	"which",
	"how",
	"does",
	"do",
	"is",
	"are",
	"can",
	"should",
	"would",
	"will",
]);

export const isQuestion = (line: string): boolean => {
	const text = line.trim();
	if (text === "") return false;
	if (text.endsWith("?")) return true;
	const first = text.split(/[^\p{L}\p{N}]+/u)[0] ?? "";
	return INTERROGATIVES.has(first.toLowerCase());
};

/** The non-blank lines of stdin, in the order they arrived. */
export const linesOf = (stdin: string): ReadonlyArray<string> =>
	stdin
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

/** Cut to `limit` characters on a word boundary, so a truncated title never ends mid-word. */
export const truncateOnWordBoundary = (text: string, limit = TITLE_LIMIT): string => {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit);
	const space = cut.lastIndexOf(" ");
	return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
};

/** The map's title: the destination verbatim, prefixed and truncated. */
export const mapTitle = (destination: string): string =>
	truncateOnWordBoundary(`${TITLE_PREFIX}${destination.trim()}`);

/**
 * Whether two short noun phrases name the same thing, by the shared dedup ranking.
 *
 * The floor is `dedup`'s own {@link TOKEN_FLOOR}: below it a phrase carries no information about
 * *this* destination, so a match on one token is not a match at all.
 */
export const namesSameThing = (a: string, b: string): boolean => {
	const tokens = tokenize(a);
	return tokens.length >= TOKEN_FLOOR && scoreTitle(tokens, b) >= TOKEN_FLOOR;
};

export interface QuestionCandidate {
	readonly issue: number;
	readonly score: number;
	readonly title: string;
}

/**
 * The board rows that rank against one question.
 *
 * <!-- anchor: RANKING-IS-EVIDENCE-NOT-PROOF --> Advisory, and the caller never refuses on it.
 * Title-token overlap can rank a question against an issue; it cannot prove the issue answers it, and
 * seating a `NOT_FOG` refusal on a ranking would dress a stochastic judgment in a proven exit code.
 */
export const candidatesFor = (
	question: string,
	rows: ReadonlyArray<{readonly number: number; readonly title: string}>,
	limit = 5,
): ReadonlyArray<QuestionCandidate> =>
	rank({
		tokens: tokenize(question),
		queue: [],
		search: rows,
		limit,
		label: "board",
	})
		.candidates.filter((candidate) => candidate.score >= TOKEN_FLOOR)
		.map((candidate) => ({
			issue: candidate.number,
			score: candidate.score,
			title: candidate.title,
		}));
