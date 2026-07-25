/**
 * `adr-sweep` core — pure, IO-free derivation of a **contradiction shortlist** for a new
 * ADR: the live `accepted` ADRs that decide in the same domain and that the new ADR does
 * **not** cite. It is the mechanical input to the ADR contradiction sweep the `adr` and
 * `review-doc` skills mandate (#3980); the judgement — is this shortlist entry an actual
 * contradiction? — stays with the author/reviewer.
 *
 * **What this detects, stated once and honestly.** The signal is *lexical + tag overlap on
 * decision-bearing text, minus the new ADR's own citations*. It surfaces the common shape of
 * the two motivating misses — an ADR that changes a rule in a domain another live ADR already
 * governs, without naming it (#3896: 0208 vs 0072; #3955: 0210 vs 0202). It does **not**
 * detect semantic contradiction: two ADRs that disagree about what a label *means* while
 * sharing no distinctive vocabulary are invisible here (the 0210-vs-0203 relocation). So
 * `no-overlap` means "nothing mechanically adjacent to open", never "no contradiction" —
 * `SweepOutcome` keeps those two apart by construction, and so must every consumer.
 */

import {frontmatterBlock, parseFrontmatter} from "../decisions-index/decisions-index.ts";

/** A `.decisions/` file handed to the core: its base name + full text. */
export interface AdrDoc {
	/** Base name only, e.g. `0072-milestones-encode-strategic-sequencing.md`. */
	readonly file: string;
	/** The file's full UTF-8 contents. */
	readonly text: string;
}

/** One parsed ADR, reduced to what the sweep keys on. */
export interface AdrRecord {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly file: string;
	readonly tags: ReadonlyArray<string>;
	/** Distinctive tokens of the ADR's decision-bearing text (tags are scored separately). */
	readonly terms: ReadonlySet<string>;
}

/** A shortlist entry: a live-accepted ADR the new one neither cites nor amends. */
export interface Candidate {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly file: string;
	/** IDF-weighted overlap; higher = more decision-domain adjacency. */
	readonly score: number;
	/** The shared terms that earned the score, strongest first. */
	readonly sharedTerms: ReadonlyArray<string>;
	readonly sharedTags: ReadonlyArray<string>;
}

/**
 * The three sweep outcomes. `indeterminate` is a **distinct** outcome from `no-overlap` on
 * purpose: collapsing "I swept and found nothing adjacent" into "I could not sweep" is the
 * exact silent-miss this tool exists to remove.
 */
export type SweepOutcome =
	| {readonly _tag: "shortlist"; readonly candidates: ReadonlyArray<Candidate>}
	| {readonly _tag: "no-overlap"}
	| {readonly _tag: "indeterminate"; readonly reason: string};

export interface SweepResult {
	readonly newId: string;
	readonly newFile: string;
	/** ADR files parsed from the corpus (the new ADR excluded). */
	readonly scanned: number;
	/** Live-accepted corpus ADRs the new one does not cite — the swept set. */
	readonly inScope: number;
	/** ADR ids the new ADR cites (excluded from the swept set). */
	readonly cited: ReadonlyArray<string>;
	/** How many distinctive terms the new ADR yielded — 0 forces `indeterminate`. */
	readonly termCount: number;
	readonly outcome: SweepOutcome;
}

/** A corpus the sweep refuses to run over: malformed frontmatter, or nothing to sweep. */
export class SweepScopeError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.name = "SweepScopeError";
		this.detail = detail;
	}
}

/**
 * A shared tag AMPLIFIES vocabulary overlap; it never substitutes for it. Scoring a tag as a
 * term in its own right let two ADRs that share only `[process, pipeline]` and not one word of
 * decision vocabulary outrank the real hit — on the 0208 instance that pushed 0072 to rank 3
 * behind two tag-only matches. Overlap earns the score, tags scale it.
 */
const TAG_BONUS = 0.5;

/** Default shortlist depth — enough to hold a real hit, short enough that a reviewer opens all of them. */
export const DEFAULT_LIMIT = 8;

/**
 * Below this many live-accepted ADRs, rarity has no corpus to be rare against: every term is
 * carried by a large fraction of the set, every IDF clamps toward 0, and the sweep finds nothing
 * — a **degenerate silence**, not a clean sweep. It reports `indeterminate` instead, because
 * letting that silence read as "no contradiction" is precisely the collapse this tool exists to
 * prevent.
 */
export const MIN_CORPUS_FOR_RARITY = 10;

/** Tokens too short or too common to carry decision-domain signal. */
const STOPWORDS = new Set([
	"about",
	"above",
	"across",
	"after",
	"again",
	"against",
	"agent",
	"agents",
	"already",
	"also",
	"always",
	"among",
	"another",
	"anything",
	"because",
	"become",
	"been",
	"before",
	"being",
	"below",
	"between",
	"both",
	"cannot",
	"case",
	"cases",
	"change",
	"changes",
	"come",
	"comes",
	"could",
	"decide",
	"decides",
	"decision",
	"decisions",
	"does",
	"doing",
	"done",
	"down",
	"each",
	"either",
	"else",
	"enough",
	"even",
	"ever",
	"every",
	"exactly",
	"first",
	"from",
	"full",
	"give",
	"gives",
	"goes",
	"gets",
	"hard",
	"have",
	"here",
	"however",
	"instead",
	"into",
	"itself",
	"just",
	"keep",
	"keeps",
	"kind",
	"know",
	"less",
	"like",
	"long",
	"made",
	"make",
	"makes",
	"many",
	"means",
	"more",
	"most",
	"much",
	"must",
	"need",
	"needs",
	"never",
	"next",
	"nothing",
	"once",
	"only",
	"onto",
	"other",
	"others",
	"over",
	"own",
	"part",
	"place",
	"rather",
	"real",
	"reason",
	"repo",
	"right",
	"same",
	"says",
	"second",
	"see",
	"shape",
	"should",
	"significant",
	"simply",
	"since",
	"some",
	"something",
	"still",
	"such",
	"take",
	"takes",
	"than",
	"that",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"thing",
	"things",
	"this",
	"those",
	"through",
	"thus",
	"time",
	"together",
	"under",
	"until",
	"upon",
	"used",
	"uses",
	"using",
	"very",
	"want",
	"well",
	"were",
	"what",
	"when",
	"where",
	"whether",
	"which",
	"while",
	"whole",
	"whose",
	"will",
	"with",
	"within",
	"without",
	"would",
	"your",
]);

const MIN_TERM_LENGTH = 4;

/**
 * Strip markdown link syntax, HTML comments, and code fences to their readable text, so a
 * `[0072](0072-slug.md)` link contributes its label rather than its slug's tokens (the slug
 * would otherwise inflate overlap with the very ADR the link already cites).
 */
const readableText = (text: string): string =>
	text
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

/**
 * Crude de-pluralization so `milestones` and `milestone` are the same term — the shared token
 * that ties 0208 to 0072. Only a trailing `s` is stripped, and never off an `-ss` word.
 */
const singular = (token: string): string =>
	token.length > MIN_TERM_LENGTH && token.endsWith("s") && !token.endsWith("ss")
		? token.slice(0, -1)
		: token;

/** Distinctive tokens of a passage: lowercase, de-pluralized, stopworded, non-numeric. */
export const termsOf = (text: string): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const raw of readableText(text)
		.toLowerCase()
		.split(/[^a-z0-9]+/)) {
		if (raw.length < MIN_TERM_LENGTH) continue;
		if (/^\d+$/.test(raw)) continue;
		const token = singular(raw);
		if (token.length < MIN_TERM_LENGTH || STOPWORDS.has(token)) continue;
		out.add(token);
	}
	return out;
};

const WHAT_DECIDES = /^[ \t]*\*\*What this decides:\*\*[ \t]*(.+)$/m;
const DECISION_SECTION = /^##[ \t]+Decision[ \t]*\r?\n([\s\S]*?)(?=\r?\n##[ \t]|$)/m;

/**
 * The decision-bearing passage of an ADR: its `title`, its `**What this decides:**` gloss, and
 * its `## Decision` section (which carries the `Binding constraints` / `Banned` lists). Context
 * and Consequences are deliberately out — they narrate, they do not rule.
 */
export const decisionText = (title: string, body: string): string =>
	[title, body.match(WHAT_DECIDES)?.[1] ?? "", body.match(DECISION_SECTION)?.[1] ?? ""].join("\n");

/** The `tags: [a, b]` frontmatter row, lowercased. Absent or empty reads as no tags. */
export const parseTags = (text: string): ReadonlyArray<string> => {
	const block = frontmatterBlock(text);
	if (block === null) return [];
	const row = block.match(/^tags:[ \t]*(.*)$/m)?.[1];
	if (row === undefined) return [];
	return row
		.replace(/[[\]]/g, " ")
		.split(/[,\s]+/)
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t.length > 0);
};

/** Parse one ADR into the record the sweep keys on. Throws `SweepScopeError` on bad frontmatter. */
export const parseRecord = ({file, text}: AdrDoc): AdrRecord => {
	const fm = parseFrontmatter(text);
	for (const field of ["id", "title", "status"] as const) {
		if (fm[field] === undefined || fm[field] === "") {
			throw new SweepScopeError(`${file}: missing front-matter field \`${field}\``);
		}
	}
	const tags = parseTags(text);
	const terms = termsOf(decisionText(fm.title as string, text));
	return {
		id: fm.id as string,
		title: fm.title as string,
		status: fm.status as string,
		file,
		tags,
		terms,
	};
};

/**
 * Is this ADR still ruling? `accepted` and `amended-in-part by [NNNN]` both are — an
 * amended ADR still governs everything the amendment did not touch, which is exactly the
 * state a fresh contradiction can land on. `proposed`, `superseded`, `deprecated`,
 * `retired`, and `reference` are out of sweep scope.
 */
export const isLiveAccepted = (status: string): boolean => {
	const normalized = status
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim()
		.toLowerCase();
	return normalized.startsWith("accepted") || normalized.startsWith("amended-in-part");
};

/**
 * ADR ids the text cites. Deliberately **narrow**: only an `NNNN-slug.md` filename, a
 * `[NNNN]` bracket, or an `ADR NNNN` mention (including slash/comma runs like `ADR 0092/0107`)
 * counts. A missed citation only re-lists an already-cited ADR on the shortlist (noise); an
 * over-broad match would silently drop a real conflict (a miss), so the bias runs narrow.
 */
export const citedIds = (text: string): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const m of text.matchAll(/\b(\d{4}[a-z]?)-[a-z0-9-]+\.md\b/g)) out.add(m[1] as string);
	for (const m of text.matchAll(/\[(\d{4}[a-z]?)\]/g)) out.add(m[1] as string);
	for (const m of text.matchAll(/\bADRs?[ \t]+((?:\[?\d{4}[a-z]?\]?[ \t]*[/,]?[ \t]*)+)/gi)) {
		for (const n of (m[1] as string).matchAll(/\d{4}[a-z]?/g)) out.add(n[0]);
	}
	return out;
};

/**
 * Inverse document frequency over the swept set. A term carried by every ADR ("pipeline",
 * "issue") clamps to 0 and contributes nothing — which is what keeps a shared house-vocabulary
 * word from outranking a genuinely distinctive one.
 */
const idfTable = (records: ReadonlyArray<AdrRecord>): ReadonlyMap<string, number> => {
	const df = new Map<string, number>();
	for (const r of records) for (const t of r.terms) df.set(t, (df.get(t) ?? 0) + 1);
	const n = records.length;
	const idf = new Map<string, number>();
	for (const [term, count] of df) idf.set(term, Math.max(0, Math.log(n / (1 + count))));
	return idf;
};

const scoreAgainst = (
	subject: AdrRecord,
	candidate: AdrRecord,
	idf: ReadonlyMap<string, number>,
): {score: number; sharedTerms: ReadonlyArray<string>; sharedTags: ReadonlyArray<string>} => {
	const subjectTags = new Set(subject.tags);
	const sharedTags = candidate.tags.filter((t) => subjectTags.has(t));
	const contributions: Array<[string, number]> = [];
	for (const term of subject.terms) {
		if (!candidate.terms.has(term)) continue;
		const rarity = idf.get(term) ?? 0;
		if (rarity > 0) contributions.push([term, rarity * rarity]);
	}
	contributions.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	// Normalize by the candidate's own breadth: an ADR with a sprawling `## Decision` overlaps
	// everything by sheer surface area, which buried the short, precisely-adjacent 0072 behind
	// three verbose unrelated ADRs. Dividing by sqrt(|terms|) prices adjacency, not verbosity.
	const overlap =
		contributions.reduce((sum, [, w]) => sum + w, 0) / Math.sqrt(candidate.terms.size || 1);
	return {
		score: overlap * (1 + TAG_BONUS * sharedTags.length),
		sharedTerms: contributions.map(([t]) => t),
		sharedTags,
	};
};

export interface SweepInput {
	readonly newAdr: AdrDoc;
	/** Every `.decisions/` file except the new one (a same-id/same-file entry is dropped). */
	readonly corpus: ReadonlyArray<AdrDoc>;
	readonly limit?: number;
}

/**
 * Sweep a new ADR against the corpus. Throws `SweepScopeError` — never returns a green — when
 * the corpus cannot be read as ADRs or holds no live-accepted ADR to sweep against (ADR 0092:
 * zero scope reds, it never passes silently).
 */
export const sweep = ({newAdr, corpus, limit = DEFAULT_LIMIT}: SweepInput): SweepResult => {
	const subject = parseRecord(newAdr);
	const others = corpus
		.filter((d) => d.file !== newAdr.file)
		.map(parseRecord)
		.filter((r) => r.id !== subject.id);
	if (others.length === 0) {
		throw new SweepScopeError(
			"zero ADRs to sweep against — the corpus holds no ADR other than the subject. " +
				"Refusing to report a clean sweep over an empty corpus (ADR 0092).",
		);
	}
	const live = others.filter((r) => isLiveAccepted(r.status));
	if (live.length === 0) {
		throw new SweepScopeError(
			`zero live-accepted ADRs in scope (${others.length} parsed, none \`accepted\`/\`amended-in-part\`). ` +
				"Refusing to report a clean sweep over an empty swept set (ADR 0092).",
		);
	}
	const cited = citedIds(newAdr.text);
	const swept = live.filter((r) => !cited.has(r.id));
	const base = {
		newId: subject.id,
		newFile: subject.file,
		scanned: others.length,
		inScope: swept.length,
		cited: [...cited].sort(),
		termCount: subject.terms.size,
	};

	if (subject.terms.size === 0) {
		return {
			...base,
			outcome: {
				_tag: "indeterminate",
				reason:
					"the subject ADR yielded no distinctive decision terms (empty or missing `title` / " +
					"`**What this decides:**` / `## Decision`) — the sweep had nothing to key on, so its " +
					"silence carries no information.",
			},
		};
	}
	if (swept.length === 0) {
		return {
			...base,
			outcome: {
				_tag: "indeterminate",
				reason:
					"every live-accepted ADR is already cited by the subject — nothing was left to sweep, " +
					"so this run neither confirms nor denies a contradiction.",
			},
		};
	}
	if (live.length < MIN_CORPUS_FOR_RARITY) {
		return {
			...base,
			outcome: {
				_tag: "indeterminate",
				reason:
					`only ${live.length} live-accepted ADRs in the corpus (rarity needs at least ` +
					`${MIN_CORPUS_FOR_RARITY}) — every term scores as common, so a silent result here would ` +
					"be a degenerate silence rather than a clean sweep. Read the corpus by hand.",
			},
		};
	}

	const idf = idfTable(live);
	const candidates = swept
		.map((r) => ({record: r, ...scoreAgainst(subject, r, idf)}))
		.filter((c) => c.score > 0)
		.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1))
		.slice(0, limit)
		.map(
			({record, score, sharedTerms, sharedTags}): Candidate => ({
				id: record.id,
				title: record.title,
				status: record.status,
				file: record.file,
				score: Math.round(score * 100) / 100,
				sharedTerms,
				sharedTags,
			}),
		);

	return {
		...base,
		outcome: candidates.length === 0 ? {_tag: "no-overlap"} : {_tag: "shortlist", candidates},
	};
};

/**
 * The caveat printed on **every** run, pass or fail. A guard that reads as comprehensive while
 * missing the semantic case is worse than a narrow one that says what it covers — so the tool
 * states its own limit in its own output rather than leaving it to a doc nobody opens.
 */
export const CAVEAT =
	"adr-sweep detects LEXICAL + TAG adjacency on decision-bearing text, minus the subject's own " +
	"citations. It does NOT detect semantic contradiction: two ADRs that disagree about what a " +
	"term MEANS while sharing no distinctive vocabulary will not appear here. A clean sweep is " +
	"NOT evidence of no contradiction.";

const REMEDY =
	"Remedy for a real conflict: set `status: amended-in-part by [NNNN]` on the OLDER ADR's " +
	"status line only (body untouched — ADR immutability), and have the new ADR name the " +
	"relationship. Precedents: 0023, 0028, 0031, 0035.";

/** The human report. `--json` consumers read `SweepResult` instead. */
export const renderReport = (result: SweepResult): string => {
	const header = `adr-sweep: subject ${result.newId} (${result.newFile}) · scanned ${result.scanned} ADRs · ${result.inScope} live-accepted + uncited in scope · ${result.termCount} decision terms · cites ${result.cited.length > 0 ? result.cited.join(", ") : "nothing"}`;
	const lines: Array<string> = [header];
	switch (result.outcome._tag) {
		case "no-overlap":
			lines.push(
				"NO-OVERLAP — no uncited live-accepted ADR shares distinctive decision vocabulary with this one.",
			);
			break;
		case "indeterminate":
			lines.push(`INDETERMINATE — ${result.outcome.reason}`);
			break;
		case "shortlist": {
			lines.push(
				`SHORTLIST — ${result.outcome.candidates.length} uncited live-accepted ADR(s) decide in an adjacent domain. Open each, decide whether it rules on a question this ADR re-decides, and cite or amend it.`,
			);
			for (const c of result.outcome.candidates) {
				const tags = c.sharedTags.length > 0 ? ` · shared tags: ${c.sharedTags.join(", ")}` : "";
				lines.push(
					`  ${c.id}  score ${c.score.toFixed(2)}  ${c.title} [${c.status}]\n    shared: ${c.sharedTerms.slice(0, 12).join(", ")}${tags}\n    file: ${c.file}`,
				);
			}
			lines.push(REMEDY);
			break;
		}
	}
	lines.push(CAVEAT);
	return lines.join("\n");
};
