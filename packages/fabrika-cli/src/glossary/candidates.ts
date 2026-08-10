/**
 * `glossary drift`'s candidate extraction, stated deterministically so two implementers agree.
 *
 * Two v1 scars are designed out here rather than inherited. Its tokenizer was `/\b[a-z][a-z-]+\b/g`,
 * which excludes uppercase and all non-ASCII, so every Turkish product noun the glossary exists for
 * was structurally invisible (#4481) — {@link tokenize} splits on Unicode letter classes instead.
 * And it suppressed a candidate when a declared term contained it **or** it contained a declared
 * term, which against a 226-row register inverts the stated recall bias to about 10% measured
 * precision — suppression here is equality on the normalized key, never containment in either
 * direction.
 */
import {STOPWORDS} from "../adr/sweep.ts";
import {normalizeKey} from "./register.ts";

/** One commit's decision-bearing text. `files` is resolved separately, only where it is needed. */
export interface CommitText {
	readonly sha: string;
	readonly subject: string;
	readonly body: string;
}

export interface Candidate {
	readonly phrase: string;
	/** Distinct commits in the range whose subject or body contains the phrase. */
	readonly hits: number;
	/** The earliest commit contributing a hit — whose first changed file is the reported surface. */
	readonly firstCommit: string;
}

/** Tokens are runs of Unicode letters, digits, `-` and `_`; everything else is a separator. */
export const tokenize = (text: string): ReadonlyArray<string> =>
	text.match(/[\p{L}\p{N}\-_]+/gu) ?? [];

const QUOTED = /"([^"\n]+)"/g;
const BACKTICKED = /`([^`\n]+)`/g;

/** N-grams of `n` consecutive tokens of a single line. */
const ngrams = (tokens: ReadonlyArray<string>, n: number): ReadonlyArray<string> => {
	const out: string[] = [];
	for (let i = 0; i + n <= tokens.length; i += 1) out.push(tokens.slice(i, i + n).join(" "));
	return out;
};

/** Every double-quoted or backticked span of the whole text, plus the subject's 2- and 3-grams. */
export const phrasesOf = (commit: CommitText): ReadonlyArray<string> => {
	const text = `${commit.subject}\n${commit.body}`;
	const spans = [...text.matchAll(QUOTED), ...text.matchAll(BACKTICKED)].map(
		(match) => match[1] as string,
	);
	const subjectTokens = tokenize(commit.subject);
	return [...spans, ...ngrams(subjectTokens, 2), ...ngrams(subjectTokens, 3)];
};

/**
 * Whether a phrase survives the filter: it is not all stopwords, and every token shorter than three
 * characters is itself a declared key.
 */
export const survivesFilter = (phrase: string, declared: ReadonlySet<string>): boolean => {
	const tokens = tokenize(phrase);
	if (tokens.length === 0) return false;
	if (tokens.every((token) => STOPWORDS.has(token.toLocaleLowerCase()))) return false;
	return tokens.every((token) => token.length >= 3 || declared.has(normalizeKey(token)));
};

const encoder = new TextEncoder();

/** Byte-wise ascending, so the tie-break does not depend on a locale. */
export const compareBytes = (a: string, b: string): number => {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
		const diff = (left[i] as number) - (right[i] as number);
		if (diff !== 0) return diff;
	}
	return left.length - right.length;
};

/**
 * The surviving candidates over `commits` (oldest first), highest-ranked first.
 *
 * Suppression is **equality on the normalized key**: a phrase whose key is already declared is
 * dropped, and nothing else is.
 */
export const rankCandidates = (
	commits: ReadonlyArray<CommitText>,
	declared: ReadonlySet<string>,
	limit: number,
): ReadonlyArray<Candidate> => {
	const phrases = new Set<string>();
	for (const commit of commits) {
		for (const phrase of phrasesOf(commit)) {
			if (!survivesFilter(phrase, declared)) continue;
			if (declared.has(normalizeKey(phrase))) continue;
			phrases.add(phrase);
		}
	}

	const candidates: Candidate[] = [];
	for (const phrase of phrases) {
		const hitting = commits.filter(
			(commit) => commit.subject.includes(phrase) || commit.body.includes(phrase),
		);
		const first = hitting[0];
		if (first === undefined) continue;
		candidates.push({phrase, hits: hitting.length, firstCommit: first.sha});
	}

	return candidates
		.sort((a, b) => (b.hits !== a.hits ? b.hits - a.hits : compareBytes(a.phrase, b.phrase)))
		.slice(0, Math.max(limit, 0));
};
