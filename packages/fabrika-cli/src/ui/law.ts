/**
 * The typed prohibition registry's schema, validated **whole-file**.
 *
 * "Some rows parsed" is never an answer: a generator holding half the law believes it holds the law,
 * so one bad row refuses the file. Zero rows refuses too — a registry a repo committed asserts a
 * typed law, and an empty one is a drafting defect to surface rather than a fact to pass through
 * (ADR 0092's shape at document scale).
 *
 * The registry is normative and founder-ratified (the ADR 0194 firewall): nothing in this package
 * writes it.
 */

/** One prohibition — exactly the seven fields the #4891 ruling pins. */
export interface LawRow {
	readonly id: string;
	readonly pillar: string;
	readonly class: "blocking" | "advisory";
	readonly machineCheck: "verb" | "vlm" | "none";
	readonly source: string;
	readonly statement: string;
	readonly counterexample: string;
}

export type RegistryParse =
	| {readonly _tag: "Rows"; readonly rows: ReadonlyArray<LawRow>}
	/** The first violation, in file order — the message quotes it and refuses the whole file. */
	| {readonly _tag: "Violation"; readonly violation: string};

const FIELDS = [
	"id",
	"pillar",
	"class",
	"machineCheck",
	"source",
	"statement",
	"counterexample",
] as const;

const CLASSES = new Set(["blocking", "advisory"]);
const MACHINE_CHECKS = new Set(["verb", "vlm", "none"]);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const rowViolation = (index: number, row: unknown, seen: Set<string>): string | null => {
	const at = `rows[${index}]`;
	if (!isRecord(row)) return `${at} is not an object`;
	for (const field of FIELDS) {
		if (typeof row[field] !== "string") return `${at}.${field} is missing or not a string`;
	}
	const extra = Object.keys(row).filter((key) => !FIELDS.includes(key as (typeof FIELDS)[number]));
	if (extra[0] !== undefined) return `${at} carries an unknown field "${extra[0]}"`;
	const id = row.id as string;
	if (!KEBAB.test(id)) return `${at}.id "${id}" is not kebab-case`;
	if (seen.has(id)) return `${at}.id "${id}" is a duplicate`;
	seen.add(id);
	if (!CLASSES.has(row.class as string)) {
		return `${at}.class "${row.class as string}" is off its enum (blocking | advisory)`;
	}
	if (!MACHINE_CHECKS.has(row.machineCheck as string)) {
		return `${at}.machineCheck "${row.machineCheck as string}" is off its enum (verb | vlm | none)`;
	}
	return null;
};

/** Validate the registry's bytes against the canonical schema; rows come back in file order. */
export const parseRegistry = (text: string): RegistryParse => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {_tag: "Violation", violation: `the file is not JSON (${(err as Error).message})`};
	}
	if (!isRecord(parsed)) return {_tag: "Violation", violation: "the top level is not an object"};
	const rows = parsed.rows;
	if (!Array.isArray(rows))
		return {_tag: "Violation", violation: '"rows" is missing or not an array'};
	if (rows.length === 0)
		return {_tag: "Violation", violation: '"rows" is empty — a law file that names no law'};
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const violation = rowViolation(index, row, seen);
		if (violation !== null) return {_tag: "Violation", violation};
	}
	return {_tag: "Rows", rows: rows as ReadonlyArray<LawRow>};
};
