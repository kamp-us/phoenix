/**
 * The read-only backlog audit's two documents — the verdict row and the chunk that carries rows —
 * and the merge that folds chunks back onto the audited set.
 *
 * One reader returns one row per issue; the merge is where a sweep used to lose a row and rebuild it
 * by hand into a verdict nobody gave. So the merge never repairs: a chunk whose rows differ from the
 * count it declared, an issue judged twice, or a merged set that is not the audited set is a refusal
 * naming what it read, and no merged answer is produced.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9834
 */

export const VERDICTS = ["KILL", "DECIDE", "KEEP"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The value bar's five kill clauses, as the tokens a KILL row names. */
export const VALUE_BAR_CLAUSES = [
	"process-ceremony",
	"self-generated-churn",
	"hardening-with-no-incident",
	"superseded",
	"duplicate-of-parent",
] as const;
export type ValueBarClause = (typeof VALUE_BAR_CLAUSES)[number];

/** A KILL carries the clause it fits; a DECIDE or KEEP has none to carry. */
export type VerdictRow =
	| {
			readonly issue: number;
			readonly verdict: "KILL";
			readonly clause: ValueBarClause;
			readonly evidence: string;
	  }
	| {
			readonly issue: number;
			readonly verdict: "DECIDE" | "KEEP";
			readonly evidence: string;
	  };

export type Parsed<A> =
	| {readonly _tag: "Parsed"; readonly value: A}
	| {readonly _tag: "Refused"; readonly reason: string};

const parsed = <A>(value: A): Parsed<A> => ({_tag: "Parsed", value});
const refused = <A>(reason: string): Parsed<A> => ({_tag: "Refused", reason});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isIssueNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value > 0;

const includes = <T extends string>(set: ReadonlyArray<T>, value: unknown): value is T =>
	typeof value === "string" && (set as ReadonlyArray<string>).includes(value);

const ROW_KEYS = new Set(["issue", "verdict", "clause", "evidence"]);

/**
 * Decode one verdict row. Evidence is one line: the merged answer prints a row per line, so a tab or
 * a newline inside it would split one verdict into two.
 */
export const parseVerdictRow = (raw: unknown): Parsed<VerdictRow> => {
	if (!isRecord(raw)) return refused("a verdict row is not a JSON object");
	const unknownKey = Object.keys(raw).find((key) => !ROW_KEYS.has(key));
	if (unknownKey !== undefined) {
		return refused(`a verdict row carries the unknown key \`${unknownKey}\``);
	}
	const {issue, verdict, clause, evidence} = raw;
	if (issue === undefined) return refused("a verdict row has no issue number");
	if (!isIssueNumber(issue)) {
		return refused(`a verdict row's issue is ${JSON.stringify(issue)}, not a positive integer`);
	}
	if (!includes(VERDICTS, verdict)) {
		return refused(
			`#${issue}: unknown verdict ${JSON.stringify(verdict)} — one of ${VERDICTS.join(", ")}`,
		);
	}
	if (typeof evidence !== "string" || evidence.trim() === "") {
		return refused(`#${issue}: a ${verdict} row carries no evidence`);
	}
	if (/[\t\r\n]/.test(evidence)) {
		return refused(`#${issue}: evidence is one line — it carries a tab or a line break`);
	}
	if (verdict === "KILL") {
		if (clause === undefined) return refused(`#${issue}: a KILL names no value-bar clause`);
		if (!includes(VALUE_BAR_CLAUSES, clause)) {
			return refused(
				`#${issue}: ${JSON.stringify(clause)} is not a value-bar clause — one of ${VALUE_BAR_CLAUSES.join(", ")}`,
			);
		}
		return parsed({issue, verdict, clause, evidence});
	}
	if (clause !== undefined) {
		return refused(
			`#${issue}: a ${verdict} row names a value-bar clause, which only a KILL carries`,
		);
	}
	return parsed({issue, verdict, evidence});
};

/** One reader batch: the rows it returned and the total it declared, which is the batch's checksum. */
export interface Chunk {
	readonly name: string;
	readonly declared: number;
	readonly rows: ReadonlyArray<VerdictRow>;
}

/**
 * Decode a chunk document `{"declared": <n>, "rows": [<row>…]}`. The declared total is kept apart
 * from the rows on purpose — comparing the two is the merge's first check, so decoding never
 * reconciles them.
 */
export const parseChunk = (name: string, raw: unknown): Parsed<Chunk> => {
	if (!isRecord(raw)) return refused(`${name}: a chunk is not a JSON object`);
	const {declared, rows} = raw;
	if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
		return refused(`${name}: \`declared\` is ${JSON.stringify(declared)}, not a row count`);
	}
	if (!Array.isArray(rows)) return refused(`${name}: \`rows\` is not an array`);
	const decoded: VerdictRow[] = [];
	for (const [index, row] of rows.entries()) {
		const one = parseVerdictRow(row);
		if (one._tag === "Refused") return refused(`${name}: row ${index + 1}: ${one.reason}`);
		decoded.push(one.value);
	}
	return parsed({name, declared, rows: decoded});
};

/** One issue of the audited set. */
export interface AuditIssue {
	readonly number: number;
	readonly title: string;
}

/**
 * Decode the audited set as `triage audit-set --json` prints it. `scanned` must equal the issues
 * listed, so a set cut short on its way here refuses rather than merging over a subset.
 */
export const parseAuditSet = (raw: unknown): Parsed<ReadonlyArray<AuditIssue>> => {
	if (!isRecord(raw)) return refused("the input set is not a JSON object");
	const {issues, scanned} = raw;
	if (!Array.isArray(issues)) return refused("the input set's `issues` is not an array");
	const decoded: AuditIssue[] = [];
	const seen = new Set<number>();
	for (const entry of issues) {
		if (!isRecord(entry) || !isIssueNumber(entry.number) || typeof entry.title !== "string") {
			return refused("an input-set entry is not a `{number, title}` pair");
		}
		if (seen.has(entry.number)) return refused(`the input set lists #${entry.number} twice`);
		seen.add(entry.number);
		decoded.push({number: entry.number, title: entry.title});
	}
	if (scanned !== decoded.length) {
		return refused(
			`the input set declares scanned ${JSON.stringify(scanned)} but lists ${decoded.length} issues`,
		);
	}
	return parsed(decoded);
};

export type MergeOutcome =
	| {readonly _tag: "Merged"; readonly rows: ReadonlyArray<VerdictRow>}
	| {
			readonly _tag: "CountMismatch";
			readonly chunks: ReadonlyArray<{
				readonly name: string;
				readonly declared: number;
				readonly actual: number;
			}>;
	  }
	| {
			readonly _tag: "Duplicate";
			readonly issues: ReadonlyArray<{
				readonly issue: number;
				readonly chunks: ReadonlyArray<string>;
			}>;
	  }
	| {
			readonly _tag: "SetMismatch";
			readonly missing: ReadonlyArray<number>;
			readonly invented: ReadonlyArray<number>;
	  };

const ascending = (a: number, b: number): number => a - b;

/**
 * Fold chunks onto the audited set, refusing in a fixed order: a chunk that lost or gained a row
 * against its own checksum first, because the later checks would otherwise report its symptom; then
 * an issue judged more than once; then any issue missing from, or absent in, the audited set.
 */
export const mergeChunks = (
	input: ReadonlyArray<number>,
	chunks: ReadonlyArray<Chunk>,
): MergeOutcome => {
	const miscounted = chunks
		.filter((chunk) => chunk.rows.length !== chunk.declared)
		.map((chunk) => ({name: chunk.name, declared: chunk.declared, actual: chunk.rows.length}));
	if (miscounted.length > 0) return {_tag: "CountMismatch", chunks: miscounted};

	const seenIn = new Map<number, string[]>();
	for (const chunk of chunks) {
		for (const row of chunk.rows)
			seenIn.set(row.issue, [...(seenIn.get(row.issue) ?? []), chunk.name]);
	}
	const duplicates = [...seenIn]
		.filter(([, names]) => names.length > 1)
		.map(([issue, names]) => ({issue, chunks: names}))
		.sort((a, b) => ascending(a.issue, b.issue));
	if (duplicates.length > 0) return {_tag: "Duplicate", issues: duplicates};

	const audited = new Set(input);
	const missing = input.filter((issue) => !seenIn.has(issue)).sort(ascending);
	const invented = [...seenIn.keys()].filter((issue) => !audited.has(issue)).sort(ascending);
	if (missing.length > 0 || invented.length > 0) return {_tag: "SetMismatch", missing, invented};

	return {
		_tag: "Merged",
		rows: chunks.flatMap((chunk) => chunk.rows).sort((a, b) => ascending(a.issue, b.issue)),
	};
};

/** One merged row as one tab-separated line; a clause-less verdict prints `-` in the clause column. */
export const rowLine = (row: VerdictRow): string =>
	[row.issue, row.verdict, row.verdict === "KILL" ? row.clause : "-", row.evidence].join("\t");

export const verdictCounts = (rows: ReadonlyArray<VerdictRow>): Record<Verdict, number> => {
	const counts: Record<Verdict, number> = {KILL: 0, DECIDE: 0, KEEP: 0};
	for (const row of rows) counts[row.verdict] += 1;
	return counts;
};
