/**
 * `report dedup`'s tokenizer and ranking, pure and native to fabrika (ADR 0238).
 *
 * **All three outcomes are answers and all three exit 0.** `none` is a printed token rather than
 * empty stdout, because empty stdout is byte-identical to a verb that never ran — which is exactly
 * how v1's `intake-dedup check` reports finding no duplicate.
 *
 * `indeterminate` fires **below a floor of two surviving tokens**, not only at zero. A query that
 * tokenizes to nothing was never compared; a query that tokenizes to one generic term is AND-joined
 * into a match on everything or nothing, and neither carries information about *this* observation.
 * Reporting either as `none` is the degenerate-silence trap this token exists to close.
 *
 * **Two token lists, not one.** {@link tokenize} produces the ranking list, capped at
 * {@link MAX_TOKENS}; {@link searchTokens} narrows it to the {@link SEARCH_TOKENS} prefix the
 * AND-joined search query gets. The floor above is evaluated against the ranking list, so narrowing
 * for search never pushes a usable query into `indeterminate`.
 */

/** Beneath this many surviving tokens a run carries no information about the query. */
export const TOKEN_FLOOR = 2;
/** How many tokens ranking may score against — more tokens make {@link scoreTitle} sharper. */
export const MAX_TOKENS = 12;
/**
 * How many of those tokens reach the AND-joined search query.
 *
 * Ranking and search pull opposite ways: `scoreTitle` counts how many query tokens a title carries,
 * so more is sharper, while GitHub AND-joins the free-text terms, so every added token narrows the
 * result set. One list served both jobs until #7213, and at twelve AND-joined terms the search half
 * returned zero rows on essentially every real call — a `none` resting on one source.
 *
 * Four is measured, not guessed. Replaying #7213's reported query against `kamp-us/phoenix` on
 * 2026-08-28: 3 tokens → 17 hits, 4 → 5 hits with the missed issue #7051 ranked first, 5 → 1 hit
 * and #7051 gone. The collapse lands between 4 and 5, so 4 is the widest slice that still
 * discriminates.
 */
export const SEARCH_TOKENS = 4;

/**
 * The prefix of a ranking token list that is sent to the AND-joined search query.
 *
 * `tokenize` keeps first-seen order, so the slice is the caller's own leading keywords — the ones a
 * filer writes first and the ones most likely to name the observation.
 */
export const searchTokens = (tokens: ReadonlyArray<string>): ReadonlyArray<string> =>
	tokens.slice(0, SEARCH_TOKENS);
export const DEFAULT_LIMIT = 20;
/** What a shared prefix must reach to count as a match. */
const PREFIX = 5;

/**
 * Stopwords in **both** repo languages. Turkish is a product-copy language here, so an
 * English-only list leaves `bir`/`için`/`ile` as "distinctive" terms and lets a generic Turkish
 * query clear the floor while discriminating nothing.
 */
const STOPWORDS = new Set(
	`about after again all also and any are because been before being both but can cannot could
	did does doing done down during each either else even ever every for from further had has have
	having here how however into its itself just less like made make many may might more most much
	must never new not now off once one only other our out over own per rather same shall should
	since some still such than that the their them then there these they this those though through
	thus too under until upon use used uses using very was way well were what when where whether
	which while who whom whose why will with within without would yet you your
	ama ancak bana bazı belki ben bende beni benim bir biri birkaç birşey biz bize bizi bizim bu
	buna bunda bundan bunu bunun burada çok çünkü da daha de defa değil diğer diye eğer en gibi
	hem hep hepsi her hiç için ile ise kez ki kim mı mi mu mü nasıl ne neden nerde nerede nereye
	niçin niye o olan olarak oldu olduğu olsa olsun onlar onları onların onu ise şey şeyden şeyi
	şeyler şu şuna şunda şundan şunu tüm ve veya ya yani`.split(/\s+/),
);

/**
 * Lowercase, split on any run of non-letter non-number characters over the **full Unicode letter
 * class**, drop short tokens and stopwords, dedupe first-seen.
 *
 * The Unicode split is #3255: an ASCII-only tokenizer shreds a Turkish stem into sub-threshold
 * fragments and drops it, so the search half silently runs on fewer keywords than the caller
 * supplied.
 */
export const tokenize = (text: string, cap = MAX_TOKENS): ReadonlyArray<string> => {
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw.length < 3 || STOPWORDS.has(raw) || out.includes(raw)) continue;
		out.push(raw);
		if (out.length >= cap) break;
	}
	return out;
};

/**
 * Whether a query token matches a title token: an exact hit, or a shared prefix of at least five
 * characters — which is what lets an agglutinative Turkish inflection match a bare stem without a
 * morphological analyzer while staying off short English derivational overlaps.
 */
export const tokensMatch = (query: string, title: string): boolean =>
	query === title ||
	(query.length >= PREFIX &&
		title.length >= PREFIX &&
		query.slice(0, PREFIX) === title.slice(0, PREFIX));

export type Source = "queue" | "search" | "both";
export type Outcome = "candidates" | "none" | "indeterminate";

export interface Row {
	readonly number: number;
	readonly title: string;
}

export interface Candidate {
	readonly number: number;
	readonly source: Source;
	readonly score: number;
	readonly title: string;
}

export interface RankResult {
	readonly outcome: Outcome;
	readonly candidates: ReadonlyArray<Candidate>;
	readonly reason: string | null;
	readonly truncated: boolean;
}

/** How many of the query's tokens the title carries. */
export const scoreTitle = (tokens: ReadonlyArray<string>, title: string): number => {
	const titleTokens = tokenize(title, Number.POSITIVE_INFINITY);
	return tokens.filter((q) => titleTokens.some((t) => tokensMatch(q, t))).length;
};

export interface RankInput {
	readonly tokens: ReadonlyArray<string>;
	readonly queue: ReadonlyArray<Row>;
	readonly search: ReadonlyArray<Row>;
	readonly limit: number;
	readonly label: string;
	/**
	 * An issue number to omit from **both** sources — the issue being deduped, so it never flags
	 * itself. Absent filters nothing.
	 *
	 * The filter runs here, after retrieval and **before scoring and the cap**, so excluding an issue
	 * never changes the rank order of the rest and never lets a truncated row take the excluded
	 * issue's place. A number matching nothing is not an error: the caller's intent — "not this one"
	 * — is satisfied either way.
	 */
	readonly exclude?: number | null;
}

/**
 * Rank the two sources into one list.
 *
 * The halves are kept for different reasons and so are filtered differently: a queue row is kept
 * only when its title overlaps, while a **search row already matched server-side on title *or*
 * body**, so it is kept regardless of its title score. `both` is the strongest duplicate signal.
 */
export const rank = (input: RankInput): RankResult => {
	const {tokens, limit, label} = input;
	const excluded = input.exclude ?? null;
	const keep = (rows: ReadonlyArray<Row>) =>
		excluded === null ? rows : rows.filter((row) => row.number !== excluded);
	const queue = keep(input.queue);
	const search = keep(input.search);

	if (tokens.length < TOKEN_FLOOR) {
		return {
			outcome: "indeterminate",
			candidates: [],
			reason: `the query yielded ${tokens.length} distinctive token(s), below the floor of ${TOKEN_FLOOR} — an AND-joined query of that shape matches everything or nothing, so nothing about this observation was compared`,
			truncated: false,
		};
	}

	const merged = new Map<number, {title: string; score: number; queue: boolean; search: boolean}>();
	for (const row of queue) {
		const score = scoreTitle(tokens, row.title);
		if (score > 0) merged.set(row.number, {title: row.title, score, queue: true, search: false});
	}
	for (const row of search) {
		const existing = merged.get(row.number);
		if (existing === undefined) {
			merged.set(row.number, {
				title: row.title,
				score: scoreTitle(tokens, row.title),
				queue: false,
				search: true,
			});
		} else {
			merged.set(row.number, {...existing, search: true});
		}
	}

	const ranked = [...merged.entries()]
		.map(([number, entry]): Candidate => {
			const source: Source =
				entry.queue && entry.search ? "both" : entry.queue ? "queue" : "search";
			return {number, source, score: entry.score, title: entry.title};
		})
		.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.number - a.number));

	if (ranked.length === 0) {
		return {
			outcome: "none",
			candidates: [],
			reason: `both sources were read — ${queue.length} open issue(s) in the ${label} queue and ${search.length} search hit(s) — and none matched`,
			truncated: false,
		};
	}

	return {
		outcome: "candidates",
		candidates: ranked.slice(0, Math.max(limit, 0)),
		reason: null,
		truncated: ranked.length > Math.max(limit, 0),
	};
};

/** The line grammar for one candidate: `<number>\t<source>\t<score>\t<title>`. */
export const renderCandidate = (candidate: Candidate): string =>
	`${candidate.number}\t${candidate.source}\t${candidate.score}\t${candidate.title}`;
