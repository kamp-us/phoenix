/**
 * `adr sweep`'s ranking, pure and native to fabrika (ADR 0238).
 *
 * It ranks the uncited live-accepted records whose decision domain the subject touches, by a
 * lexical/rarity score: a term shared with the subject is worth its inverse document frequency
 * over the live-accepted corpus, so a term every ADR uses ("the", "gate", "pipeline") contributes
 * almost nothing and a term two ADRs share contributes a lot.
 *
 * **All three outcomes exit 0 and all three are answers** — that is the whole point. v1's
 * `adr-sweep` exits 1 on the one case it was asked to produce, so a caller reads its informative
 * shortlist as a failed run; and it writes `--json` to stderr leaving stdout empty (#4723). Neither
 * scar is repeated here.
 *
 * None of the outcomes is a clearance, which is why `no-overlap` is a distinct token rather than an
 * empty shortlist: an ADR that disagrees with the subject about what a *label means*, sharing no
 * distinctive vocabulary, never appears at all, and the skill reads the domain by hand regardless.
 */
import {frontmatterBlock, idSortKey, isLive, statusOf, titleOf} from "./records.ts";

/** Below this many live-accepted records, rarity is not measurable and the run carries no information. */
export const RARITY_FLOOR = 10;

/** The default shortlist cap. */
export const DEFAULT_LIMIT = 8;

export type Outcome = "shortlist" | "no-overlap" | "indeterminate";

export interface SweepCandidate {
	readonly id: string;
	readonly file: string;
	readonly text: string;
}

export interface SweepEntry {
	readonly id: string;
	readonly score: number;
	readonly file: string;
	readonly title: string;
}

export interface SweepResult {
	readonly outcome: Outcome;
	readonly entries: ReadonlyArray<SweepEntry>;
	readonly reason: string | null;
	/** Every record handed to the sweep, live or not. */
	readonly scanned: number;
	/** The live-accepted records the subject does not already cite — what was actually ranked. */
	readonly inScope: number;
	/** How many corpus ids the subject already cites. */
	readonly cited: number;
}

/**
 * A plain English stopword list. Repo-generic jargon needs no list — a term every record uses
 * has an inverse document frequency near zero and contributes nothing to a score on its own.
 *
 * Exported because `../glossary/candidates.ts` filters against the same set: two term-extraction
 * surfaces that each carried their own copy would drift apart. It imports **this and nothing else**
 * — {@link tokenize} beside it is ASCII-only, which is the defect the drift verb exists to avoid.
 */
export const STOPWORDS = new Set(
	`a about above after again against all also although always am an and any are as at be because
	been before being below between both but by can cannot could did do does doing done down during
	each either else even ever every few for from further had has have having her here hers him his
	how however if in instead into is it its itself just less let like made make makes many may
	might more most much must never new no nor not now of off on once one only or other our out over
	own per rather same shall she should since so some still such than that the their them then
	there these they this those though through thus to too two under until up upon use used uses
	using very was way we well were what when where whether which while who whom whose why will with
	within without would yet you your`.split(/\s+/),
);

/**
 * The decision-bearing text of a record: its title, its `**What this decides:**` gloss and its
 * `## Decision` section — not the whole file.
 *
 * Context and Consequences narrate *why* and *what it costs*; two ADRs contradict each other in
 * what they *decide*, so ranking on the decision text is what keeps a shared war story from
 * scoring as a shared ruling. A record with no `## Decision` heading contributes its whole body,
 * so a nonstandard record is still rankable rather than silently invisible.
 */
export const decisionBearingText = (text: string): string => {
	const title = titleOf(text);
	const body =
		frontmatterBlock(text) === null ? text : text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
	const sections = body.split(/^##\s+/m);
	const decision = sections.find((s) => /^Decision\b/.test(s));
	const gloss = /^\*\*What this decides:\*\*([^\n]*(?:\n(?!\n)[^\n]*)*)/m.exec(body)?.[1] ?? "";
	return [title, gloss, decision ?? body].join("\n");
};

/** Lowercase alphabetic terms of length ≥ 3 that are not stopwords. Pure-numeric tokens are ids, not terms. */
export const tokenize = (text: string): ReadonlyArray<string> =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t));

/** The four-digit ids a text references — the subject's own citations. */
export const citedIds = (text: string): ReadonlySet<string> =>
	new Set([...text.matchAll(/\b(\d{4})\b/g)].map((m) => m[1] ?? ""));

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Rank the corpus against the subject.
 *
 * `corpus` is every record read from `--dir` (the subject may be among them; it is excluded).
 * The rarity denominator is the **live-accepted** corpus — rarity is a property of the corpus, not
 * of the subset left after excluding citations — while only the uncited live-accepted records are
 * ranked.
 */
export const sweep = (
	subject: {readonly id: string | null; readonly text: string},
	corpus: ReadonlyArray<SweepCandidate>,
	limit: number,
): SweepResult => {
	const live = corpus.filter((c) => c.id !== subject.id && isLive(statusOf(c.text) ?? ""));
	const cites = citedIds(subject.text);
	const inScope = live.filter((c) => !cites.has(c.id));
	const scanned = corpus.length;
	const citedCount = live.length - inScope.length;

	if (live.length < RARITY_FLOOR) {
		return {
			outcome: "indeterminate",
			entries: [],
			reason: `the live-accepted corpus holds ${live.length} record(s), below the rarity floor of ${RARITY_FLOOR} — every term looks common, so a clean sweep here is degenerate rather than clean`,
			scanned,
			inScope: inScope.length,
			cited: citedCount,
		};
	}

	const docTerms = new Map<string, ReadonlySet<string>>();
	const df = new Map<string, number>();
	for (const record of live) {
		const terms = new Set(tokenize(decisionBearingText(record.text)));
		docTerms.set(record.id, terms);
		for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
	}

	const n = live.length;
	const subjectTerms = new Set(tokenize(decisionBearingText(subject.text)));
	const idf = new Map<string, number>();
	for (const term of subjectTerms) {
		const seen = df.get(term) ?? 0;
		// A term every live record carries discriminates nothing, so it is not distinctive. A term no
		// record carries IS distinctive — maximally rare — it simply scores against nobody, which is
		// how a subject with a vocabulary all its own reaches `no-overlap` rather than
		// `indeterminate`. The two outcomes say different things and must not collapse.
		if (seen < n) idf.set(term, Math.log(n / Math.max(seen, 1)));
	}

	if (idf.size === 0) {
		return {
			outcome: "indeterminate",
			entries: [],
			reason:
				"the subject yielded no distinctive terms against the live-accepted corpus — nothing to rank, so the run carries no information",
			scanned,
			inScope: inScope.length,
			cited: citedCount,
		};
	}

	const scored = inScope
		.map((record) => {
			const terms = docTerms.get(record.id) ?? new Set<string>();
			let score = 0;
			for (const [term, weight] of idf) if (terms.has(term)) score += weight;
			return {id: record.id, score: round2(score), file: record.file, title: titleOf(record.text)};
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			const [an] = idSortKey(a.id);
			const [bn] = idSortKey(b.id);
			return an - bn;
		});

	if (scored.length === 0) {
		return {
			outcome: "no-overlap",
			entries: [],
			reason:
				"no uncited live-accepted record shares a distinctive term with the subject — this is not a clearance: an ADR that disagrees about what a label means shares no vocabulary and never appears here",
			scanned,
			inScope: inScope.length,
			cited: citedCount,
		};
	}

	return {
		outcome: "shortlist",
		entries: scored.slice(0, Math.max(limit, 0)),
		reason: null,
		scanned,
		inScope: inScope.length,
		cited: citedCount,
	};
};

/** The line grammar for one shortlist entry: `<id>\t<score>\t<file>\t<title>`. */
export const renderEntry = (entry: SweepEntry): string =>
	`${entry.id}\t${entry.score.toFixed(2)}\t${entry.file}\t${entry.title}`;
