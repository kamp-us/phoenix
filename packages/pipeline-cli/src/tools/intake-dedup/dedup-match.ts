/**
 * The pure match core for `intake-dedup` (ADR 0181): the "is there already an open
 * issue for this?" heuristic the `report` and `triage` skills used to each hand-maintain
 * inline. One tested implementation — no drift between the two intake seams.
 *
 * IO-free by construction: `tokenize` + `searchQuery` shape the free-text observation into
 * a deterministic GitHub search, and `rankCandidates` fuses the two result sources (the
 * read-after-write `needs-triage` queue + the eventually-consistent search index) into one
 * deduped, title-overlap-ranked candidate list. The `github.ts` shell feeds it raw REST rows.
 */

/** A minimal open-issue row — the only two fields either seam consumed from the old queries. */
export interface IssueRef {
	readonly number: number;
	readonly title: string;
}

/** Which source(s) surfaced a candidate — `both` is the strongest duplicate signal. */
export type CandidateSource = "queue" | "search" | "both";

/** A ranked duplicate candidate: an open issue that may already cover the observation. */
export interface Candidate {
	readonly number: number;
	readonly title: string;
	readonly source: CandidateSource;
	/** Query-token overlap with the candidate's title — the rank key, higher = stronger. */
	readonly score: number;
}

/**
 * Function words + report-template scaffolding nouns that carry no dedup signal, in both
 * repo languages: English (technical) and Turkish (product/brand copy, per `.glossary/LANGUAGE.md`).
 * Turkish titles are the norm for product/brand nouns, so an English-only stoplist let Turkish
 * function words ("bir", "için", "gibi") through as false keywords (#3255). Kept deliberately
 * small: the goal is to drop pure noise ("the", "when", "issue" / "ve", "bir", "için"), not to
 * stem — an over-eager stoplist silently starves the search of real keywords.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
	// English function words + report scaffolding
	"the",
	"and",
	"for",
	"are",
	"was",
	"were",
	"with",
	"that",
	"this",
	"then",
	"than",
	"from",
	"into",
	"when",
	"what",
	"which",
	"where",
	"while",
	"have",
	"has",
	"had",
	"not",
	"but",
	"you",
	"your",
	"our",
	"its",
	"it's",
	"they",
	"them",
	"their",
	"there",
	"here",
	"can",
	"cant",
	"will",
	"would",
	"should",
	"could",
	"issue",
	"issues",
	"bug",
	"report",
	"todo",
	// Turkish function words (conjunctions, postpositions, determiners, adverbs); the sub-3-char
	// ones ("ve", "ile", "bu") are already length-dropped, listed for intent.
	"ve",
	"ile",
	"veya",
	"ya",
	"ama",
	"fakat",
	"ancak",
	"çünkü",
	"için",
	"gibi",
	"kadar",
	"göre",
	"bir",
	"birkaç",
	"her",
	"hem",
	"daha",
	"çok",
	"ise",
	"yani",
	"üzere",
	"sonra",
	"önce",
]);

/** Tokens shorter than this carry no discriminating signal (`a`, `to`, `id`). */
const MIN_TOKEN_LENGTH = 3;

/**
 * A query token shares a stem with a title token when their common prefix is at least this
 * long — the relaxation that lets agglutinative Turkish inflections match a bare stem
 * ("sözlük" / "sözlükte" / "sözlüğe", the last also crossing the k→ğ consonant mutation, all
 * share the "sözlü" prefix). Set above typical English derivational overlap ("work"/"workflow"
 * share only 4) so exact-token English behavior is preserved: relaxed matching only *adds*
 * stem hits, never removes an exact one (#3255).
 */
const STEM_MIN_LENGTH = 5;

/**
 * Cap on keyword count in the built query. A GitHub search AND-joins its terms, so an
 * over-long query from a whole paragraph matches nothing; the first N high-signal tokens
 * (insertion order, so the title/lead words win) keep the query usefully broad.
 */
const MAX_QUERY_TOKENS = 12;

/**
 * Split free text into the deterministic keyword set the search half runs on: lowercase,
 * break on any run of non-letter/non-number characters, drop stopwords and sub-`MIN_TOKEN_LENGTH`
 * tokens, dedupe preserving first-seen order, cap at `MAX_QUERY_TOKENS`.
 *
 * The split class is Unicode `\p{L}\p{N}` (`u` flag), not the old ASCII `[a-z0-9]`, so Turkish
 * letters (ö ü ğ ş ç ı and their uppercase forms) are word characters that survive tokenization
 * instead of shredding a stem into sub-`MIN_TOKEN_LENGTH` fragments — the root cause of #3255,
 * where "sözlük" split into "s"/"zl"/"k" and vanished entirely. The lone casing artifact is
 * dotted-capital İ, which default `.toLowerCase()` maps to "i" + U+0307 (combining dot); we strip
 * that combining dot so "İşleri" tokenizes to "işleri" rather than breaking at the mark.
 */
export const tokenize = (text: string): ReadonlyArray<string> => {
	const seen = new Set<string>();
	const out: Array<string> = [];
	const normalized = text.toLowerCase().replace(/\u0307/g, "");
	for (const raw of normalized.split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < MIN_TOKEN_LENGTH || STOPWORDS.has(raw) || seen.has(raw)) continue;
		seen.add(raw);
		out.push(raw);
		if (out.length >= MAX_QUERY_TOKENS) break;
	}
	return out;
};

/**
 * The GitHub `search/issues` `q` value for `repo`'s open issues over `tokens`: the
 * `repo:` / `is:issue` / `is:open` qualifiers plus the space-joined keywords. Space-joined
 * (not `+`-joined) because the caller passes this through `gh api -f q=…`, which URL-encodes
 * the field — so no raw-space-in-URL hazard the hand-written queries had to `+`-guard against.
 */
export const searchQuery = (repo: string, tokens: ReadonlyArray<string>): string =>
	[`repo:${repo}`, "is:issue", "is:open", ...tokens].join(" ");

/** Length of the shared leading run of `a` and `b` — the stem-overlap primitive. */
const commonPrefixLength = (a: string, b: string): number => {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i += 1;
	return i;
};

/**
 * Whether a query token and a title token name the same stem: an exact hit, or a shared
 * prefix of at least `STEM_MIN_LENGTH`. The prefix arm is what surfaces agglutinative Turkish
 * inflections against a bare stem ("sözlük" vs "sözlükte"/"sözlüğe") without a full morphological
 * analyzer; the length floor keeps it off short English derivational overlaps (#3255).
 */
export const tokensRelated = (a: string, b: string): boolean =>
	a === b || commonPrefixLength(a, b) >= STEM_MIN_LENGTH;

/** Count how many of `tokens` share a stem with a token of `title` — the title-overlap score. */
export const titleScore = (title: string, tokens: ReadonlyArray<string>): number => {
	if (tokens.length === 0) return 0;
	const titleTokens = tokenize(title);
	let score = 0;
	for (const t of tokens) if (titleTokens.some((tt) => tokensRelated(t, tt))) score += 1;
	return score;
};

export interface RankInput {
	readonly queue: ReadonlyArray<IssueRef>;
	readonly search: ReadonlyArray<IssueRef>;
	readonly tokens: ReadonlyArray<string>;
	/** Issue number to omit — the very issue being deduped, so it never flags itself (triage seam). */
	readonly exclude?: number | undefined;
	readonly limit: number;
}

/**
 * Fuse the two result sources into one ranked candidate list. The `needs-triage` queue is
 * unfiltered server-side, so a queue row is kept only when its title shares a query token
 * (score > 0); a search row already matched server-side (title *or* body), so it is kept
 * regardless of title overlap. A number seen in both sources upgrades to `source: "both"` —
 * the strongest duplicate signal — and takes the higher score. Ranked by score desc, then
 * newer (higher number) first; capped at `limit`.
 */
export const rankCandidates = (input: RankInput): ReadonlyArray<Candidate> => {
	const {queue, search, tokens, exclude, limit} = input;
	const byNumber = new Map<number, Candidate>();

	const add = (ref: IssueRef, source: "queue" | "search", keepZero: boolean): void => {
		if (ref.number === exclude) return;
		const score = titleScore(ref.title, tokens);
		if (!keepZero && score === 0) return;
		const prior = byNumber.get(ref.number);
		if (prior === undefined) {
			byNumber.set(ref.number, {number: ref.number, title: ref.title, source, score});
			return;
		}
		byNumber.set(ref.number, {
			...prior,
			source: "both",
			score: Math.max(prior.score, score),
		});
	};

	for (const ref of queue) add(ref, "queue", false);
	for (const ref of search) add(ref, "search", true);

	return [...byNumber.values()]
		.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.number - a.number))
		.slice(0, limit);
};
