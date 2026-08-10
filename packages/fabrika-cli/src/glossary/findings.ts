/**
 * What `glossary check` looks for, as a pure function of parsed rows plus resolved citations.
 *
 * Each `kind` is a decidable predicate over the file; what to *do* about one is the skill's. The
 * `detail` text is fixed per kind because a caller may grep it.
 */
import type {RegisterName, Row} from "./register.ts";

export type FindingKind =
	| "row-shape"
	| "duplicate-key"
	| "cross-register"
	| "out-of-order"
	| "citation-dead"
	| "citation-superseded"
	| "citations-unverified";

/** The closed set, in the order findings are emitted. */
export const KINDS: ReadonlyArray<FindingKind> = [
	"row-shape",
	"duplicate-key",
	"cross-register",
	"out-of-order",
	"citation-dead",
	"citation-superseded",
	"citations-unverified",
];

export interface Finding {
	readonly kind: FindingKind;
	readonly register: string;
	readonly section: string;
	readonly term: string;
	readonly detail: string;
}

export interface RegisterRows {
	readonly register: RegisterName;
	readonly rows: ReadonlyArray<Row>;
}

/** What a cited decision id resolved to. `Dead` is proven absence, never a failed read. */
export type CitationState =
	| {readonly _tag: "Live"}
	| {readonly _tag: "Dead"}
	| {readonly _tag: "Superseded"; readonly status: string};

const CITATION = /\b(\d{4})\b/g;

/** The four-digit ids a row cites — cells 2 and 3 only, never the term itself. */
export const citationsOf = (row: Row): ReadonlyArray<string> => {
	const text = [row.cells[1] ?? "", row.cells[2] ?? ""].join(" ");
	return [...text.matchAll(CITATION)].map((match) => match[1] as string);
};

const collator = new Intl.Collator("en", {sensitivity: "base"});

/** Ascending `normalizeKey` order — the order `add` places a row into and `check` reports against. */
export const compareKeys = (a: string, b: string): number => collator.compare(a, b);

const rowShape = (register: string, row: Row): Finding | null => {
	if (row.cells.length !== 3) {
		return {
			kind: "row-shape",
			register,
			section: row.section,
			term: row.term,
			detail: `expected 3 cells, found ${row.cells.length}`,
		};
	}
	// The third cell — `Not` — is legitimately empty on most rows, so only 1 and 2 are required.
	for (const index of [0, 1]) {
		if ((row.cells[index] ?? "") === "") {
			return {
				kind: "row-shape",
				register,
				section: row.section,
				term: row.term,
				detail: `cell ${index + 1} is empty`,
			};
		}
	}
	return null;
};

export interface DefectInput {
	readonly registers: ReadonlyArray<RegisterRows>;
	/** Cited id → what it resolved to. Absent from the map means it was never resolved. */
	readonly citations: ReadonlyMap<string, CitationState>;
	/** The reason `--decisions` could not be read, or `null` when it was. */
	readonly citationsUnverified: string | null;
	readonly decisionsDir: string;
}

export const findDefects = (input: DefectInput): ReadonlyArray<Finding> => {
	const findings: Finding[] = [];

	for (const {register, rows} of input.registers) {
		const seen = new Map<string, Row>();
		for (const row of rows) {
			const shape = rowShape(register, row);
			if (shape !== null) findings.push(shape);

			const earlier = seen.get(row.key);
			if (earlier === undefined) seen.set(row.key, row);
			else {
				findings.push({
					kind: "duplicate-key",
					register,
					section: row.section,
					term: row.term,
					detail: `also declared in "${earlier.section}"`,
				});
			}
		}

		for (const [index, row] of rows.entries()) {
			const previous = rows[index - 1];
			if (previous === undefined || previous.section !== row.section) continue;
			if (compareKeys(previous.key, row.key) <= 0) continue;
			findings.push({
				kind: "out-of-order",
				register,
				section: row.section,
				term: row.term,
				detail: `sorts before "${previous.term}"`,
			});
		}
	}

	const [first, second] = input.registers;
	if (first !== undefined && second !== undefined) {
		const earlier = new Map(first.rows.map((row) => [row.key, row] as const));
		for (const row of second.rows) {
			const twin = earlier.get(row.key);
			if (twin === undefined) continue;
			findings.push({
				kind: "cross-register",
				register: second.register,
				section: row.section,
				term: row.term,
				detail: `also declared in ${first.register} under "${twin.section}"`,
			});
		}
	}

	for (const {register, rows} of input.registers) {
		for (const row of rows) {
			for (const id of citationsOf(row)) {
				const state = input.citations.get(id);
				if (state === undefined || state._tag === "Live") continue;
				findings.push(
					state._tag === "Dead"
						? {
								kind: "citation-dead",
								register,
								section: row.section,
								term: row.term,
								detail: `cites ${id}, no record under ${input.decisionsDir}`,
							}
						: {
								kind: "citation-superseded",
								register,
								section: row.section,
								term: row.term,
								detail: `cites ${id}, status "${state.status}"`,
							},
				);
			}
		}
	}

	if (input.citationsUnverified !== null) {
		findings.push({
			kind: "citations-unverified",
			register: "-",
			section: "-",
			term: "-",
			detail: `cannot read ${input.decisionsDir}: ${input.citationsUnverified}`,
		});
	}

	return [...findings].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
};

/** The line grammar for one finding: `<kind>\t<register>\t<section>\t<term>\t<detail>`. */
export const renderFinding = (finding: Finding): string =>
	[finding.kind, finding.register, finding.section, finding.term, finding.detail].join("\t");
