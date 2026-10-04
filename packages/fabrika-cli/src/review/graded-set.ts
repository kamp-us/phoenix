/**
 * The set a review gate grades: the issue body's acceptance criteria **plus** every standing ruling
 * on that issue, folded into one ordered list where each row says which of the two it came from.
 *
 * The defect this closes: the gate read the body and nothing else, so a founder ruling posted as a
 * comment — which is how rulings are delivered here — changed nothing about what any gate graded.
 * One issue carried ten pre-ruling criteria while three rulings landed on it as comments; the PR
 * that contradicted all three passed two independent reviews, because the criteria discharged and
 * the constraints that contradicted them were not criteria.
 *
 * **Body order first, rulings after, oldest ruling first.** The body block is the contract as
 * minted, and a ruling is an amendment with a date on it; printing them in the order they were made
 * is what lets a reader see a later ruling reverse an earlier one. Recency is the tiebreak the gate
 * states, never a re-sort that hides the sequence.
 *
 * **Superseding is declared, never inferred.** Only a ruling marker carrying `supersedes:<k>` marks
 * body row `k`, and that row stays in the set flagged rather than dropped — a contract row that
 * vanishes reads to the next reviewer as a row nobody ever wrote. A marker naming a row the block
 * does not have supersedes nothing and is reported, because the alternative is silently discarding a
 * founder's statement about which row he replaced.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 */

import type {StandingRuling} from "../decision/ruling.ts";
import type {AcceptanceCriterion} from "../wire/acceptance-criteria.ts";

/** Which artifact a graded row was read out of. */
export type RowSource = "body" | "ruling";

/**
 * What a row is owed by now.
 *
 * `superseded` is a body row a ruling replaced: it is reported and not graded. `checked` and `open`
 * keep the block's own checkbox meaning, and a ruling row is always `open` — a ruling carries no
 * checkbox and nothing ticks one.
 */
export type RowState = "open" | "checked" | "superseded";

export interface GradedRow {
	readonly source: RowSource;
	readonly state: RowState;
	/** The criterion's text, or — on a ruling row — the founder's own words at the cited comment. */
	readonly text: string;
	/** A body row's outside-diff evidence source; `null` on every ruling row. */
	readonly evidence: string | null;
	/** A ruling row's comment URL; `null` on every body row. */
	readonly ruling: string | null;
	/** A ruling row's stamp; `null` on every body row. */
	readonly at: string | null;
	/** On a ruling row, the 1-based body position it replaced; `null` where it replaced none. */
	readonly supersedes: number | null;
}

export interface GradedSet {
	readonly rows: ReadonlyArray<GradedRow>;
	/** How many rows came from a ruling. */
	readonly rulings: number;
	/** How many body rows a ruling superseded. */
	readonly superseded: number;
	/**
	 * `supersedes:<k>` values naming a row the block does not have, in marker order.
	 *
	 * Never dropped: the marker is a founder saying which criterion he replaced, and a fold that
	 * discarded it would grade the superseded row as though he had said nothing.
	 */
	readonly danglingSupersedes: ReadonlyArray<number>;
}

/**
 * The words a ruling row carries.
 *
 * The marker cites a comment; it does not quote it. A caller that can fetch that comment hands its
 * body in through `text`, and one that cannot passes `null` — the row then carries the URL as its
 * own text, which is still a row a reviewer can act on rather than a row that silently is not there.
 */
export interface RulingText {
	readonly ruling: StandingRuling;
	readonly text: string | null;
}

/** Collapse a ruling comment to one line, because the answer's grammar is one row per line. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Fold a body block and an issue's standing rulings into the one set a gate grades.
 *
 * `criteria` is the block exactly as the wire format read it, and `rulings` is `scanRulings`' own
 * ordering — oldest first, author-gated already. Neither is re-derived here: this is a fold and it
 * reads nothing.
 */
export const gradedSet = (
	criteria: ReadonlyArray<AcceptanceCriterion>,
	rulings: ReadonlyArray<RulingText>,
): GradedSet => {
	const supersededRows = new Set<number>();
	const dangling: number[] = [];
	for (const {ruling} of rulings) {
		const position = ruling.ruling.supersedes;
		if (position === null) continue;
		if (position > criteria.length) {
			dangling.push(position);
			continue;
		}
		supersededRows.add(position);
	}

	const body: GradedRow[] = criteria.map((criterion, index) => ({
		source: "body" as const,
		state: supersededRows.has(index + 1)
			? ("superseded" as const)
			: criterion.checked
				? ("checked" as const)
				: ("open" as const),
		text: criterion.text,
		evidence: criterion.evidence,
		ruling: null,
		at: null,
		supersedes: null,
	}));

	const ruled: GradedRow[] = rulings.map(({ruling, text}) => ({
		source: "ruling" as const,
		state: "open" as const,
		text: text === null ? ruling.ruling.ruling : oneLine(text),
		evidence: null,
		ruling: ruling.ruling.ruling,
		at: ruling.ruling.at,
		supersedes: ruling.ruling.supersedes,
	}));

	return {
		rows: [...body, ...ruled],
		rulings: ruled.length,
		superseded: supersededRows.size,
		danglingSupersedes: dangling,
	};
};

/** One `<source>\t<state>\t<text>[\t<evidence|ruling url>]` line per row — the verb's stdout. */
export const renderGradedSet = (set: GradedSet): ReadonlyArray<string> =>
	set.rows.map((row) => {
		const tail = row.source === "body" ? row.evidence : row.ruling;
		return `${row.source}\t${row.state}\t${oneLine(row.text)}${tail === null ? "" : `\t${tail}`}`;
	});
