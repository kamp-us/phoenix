/**
 * The governance digest — the ranked table of decision records that landed in a window, carried on
 * the durable readout issue.
 *
 *     ## Governance readout
 *
 *     ```governance-digest
 *     row	0398	tension	sits against ADR 0173 on whether a pending check blocks admission
 *     ```
 *
 * Producer `governance readout`, consumer the front door. Three fields per row: the decision id, one
 * of three **closed** kinds, and a one-line note.
 *
 * **The note is a pointer, never a directive.** A receiver re-fetches the record the id names and
 * reads it there, which is what keeps a coordination artifact from steering whoever reads it — so the
 * vocabulary is closed and free prose is confined to that one field.
 *
 * **The digest gates nothing.** There is no polarity here and no code that means "the corpus is in a
 * bad state": a digest that could red would be the human gate the #4927 ruling retired, wearing a new
 * name.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const RECORD_ID: unique symbol;
declare const NOTE: unique symbol;

/** A four-digit decision id. Branded so a `Found` cannot carry `""` or a half-written id. */
export type RecordId = string & {readonly [RECORD_ID]: true};
/** The one-line note. Branded for the same reason: a blank note points at nothing. */
export type Note = string & {readonly [NOTE]: true};

/** What the row says about the record. A fourth token is not a kind — it is a drift. */
export type DigestKind = "tension" | "blast" | "routine";

export interface DigestRow {
	readonly id: RecordId;
	readonly kind: DigestKind;
	readonly note: Note;
}

export type GovernanceDigest = NonEmptyReadonlyArray<DigestRow>;
export type GovernanceDigestRead = WireRead<GovernanceDigest>;

/** The `--format` key, the fence's info string, and the heading the block sits under. */
export const KEY = "governance-digest";
export const HEADING = "## Governance readout";
/** The row grammar's leading token, which is also what `governance readout` reads off stdin. */
export const ROW = "row";

export const KINDS: ReadonlyArray<DigestKind> = ["tension", "blast", "routine"];

const HEADING_ANY_LEVEL = /^#{1,6}[ \t]+Governance readout[ \t]*$/i;
const FENCE_OPEN = new RegExp(`^\`{3,}[ \t]*${KEY}[ \t]*$`);
const FENCE_CLOSE = /^`{3,}[ \t]*$/;
const FOUR_DIGITS = /^\d{4}$/;

export const recordId = (raw: string): RecordId | null =>
	FOUR_DIGITS.test(raw.trim()) ? (raw.trim() as RecordId) : null;

export const note = (raw: string): Note | null => {
	const value = raw.trim();
	return value === "" ? null : (value as Note);
};

export const digestKind = (raw: string): DigestKind | null => {
	const value = raw.trim().toLowerCase();
	return KINDS.find((kind) => kind === value) ?? null;
};

const malformed = (reason: string, evidence: string): GovernanceDigestRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** One `row\t<id>\t<kind>\t<note>` line as a row, or the reason it is not one. */
export const parseRow = (line: string): DigestRow | string => {
	const fields = line.split("\t");
	if (fields[0]?.trim() !== ROW) {
		return `"${line.trim()}" does not open with the "${ROW}" token — every digest line is a row`;
	}
	if (fields.length !== 4) {
		return `a row carries exactly ${ROW}, id, kind and note — this one carries ${fields.length} field(s)`;
	}
	const id = recordId(fields[1] ?? "");
	if (id === null) return `"${(fields[1] ?? "").trim()}" is not a four-digit decision id`;
	const kind = digestKind(fields[2] ?? "");
	if (kind === null) {
		return `"${(fields[2] ?? "").trim()}" is outside ${KINDS.join("/")}`;
	}
	const text = note(fields[3] ?? "");
	if (text === null) return `row ${id} carries no note — the field that says why the row is here`;
	return {id, kind, note: text};
};

/**
 * Read the digest out of an artifact. Total: `Found` | `Absent` | `Malformed`.
 *
 * A drifted heading level is `Malformed` rather than `Absent`, which is the discrimination that
 * carries the weight: an artifact plainly reaching for this block and missing must never read back as
 * "this issue carries no readout", because that is the answer a receiver acts on by doing nothing.
 */
export const read = (artifact: string): GovernanceDigestRead => {
	const lines = artifact.split("\n");
	const headingAt = lines.findIndex((line) => HEADING_ANY_LEVEL.test(line));
	const fenceAt = lines.findIndex((line) => FENCE_OPEN.test(line));
	if (headingAt === -1 && fenceAt === -1) {
		return {
			_tag: "Absent",
			reason: `the artifact carries no "${HEADING}" heading over a \`${KEY}\` fence — no block of this format`,
		};
	}
	if (headingAt === -1) {
		return malformed(
			`the \`${KEY}\` fence sits under no "${HEADING}" heading`,
			`line ${fenceAt + 1}: "${(lines[fenceAt] ?? "").trim()}"`,
		);
	}
	const heading = lines[headingAt] ?? "";
	if (heading.trim() !== HEADING) {
		return malformed(
			`the heading is "${heading.trim()}", not "${HEADING}" — the level and spelling are the block's anchor`,
			`line ${headingAt + 1}: "${heading.trim()}"`,
		);
	}
	if (fenceAt === -1 || fenceAt < headingAt) {
		return malformed(
			`the "${HEADING}" heading is present with no \`${KEY}\` fence under it`,
			`line ${headingAt + 1}: "${heading.trim()}"`,
		);
	}

	const rows: DigestRow[] = [];
	for (let i = fenceAt + 1; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (FENCE_CLOSE.test(line)) break;
		if (line.trim() === "") continue;
		const parsed = parseRow(line);
		if (typeof parsed === "string") return malformed(parsed, `line ${i + 1}: "${line.trim()}"`);
		rows.push(parsed);
	}
	const [first, ...rest] = rows;
	if (first === undefined) {
		return malformed(
			`the \`${KEY}\` fence holds no row — an empty digest is not a digest`,
			`line ${fenceAt + 1}: "${(lines[fenceAt] ?? "").trim()}"`,
		);
	}
	return {_tag: "Found", value: [first, ...rest]};
};

export const emitRow = (row: DigestRow): string => `${ROW}\t${row.id}\t${row.kind}\t${row.note}`;

/** Compose the whole block. Round-trips through {@link read}. */
export const emit = (rows: GovernanceDigest): string =>
	`${HEADING}\n\n\`\`\`${KEY}\n${rows.map(emitRow).join("\n")}\n\`\`\`\n`;

/** One row line per row — read output that pipes straight back into {@link emitFromFields}. */
export const renderRows = (rows: GovernanceDigest): NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = rows.map(emitRow);
	if (first === undefined) throw new Error("a non-empty row list rendered no lines");
	return [first, ...rest];
};

export type DigestFields =
	| {readonly _tag: "Fields"; readonly rows: GovernanceDigest}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** Parse `emit`'s stdin: one `row\t<id>\t<kind>\t<note>` per line, in the order they are ranked. */
export const parseFields = (fields: string): DigestFields => {
	const lines = fields.split("\n").filter((line) => line.trim() !== "");
	const rows: DigestRow[] = [];
	for (const [index, line] of lines.entries()) {
		const parsed = parseRow(line);
		if (typeof parsed === "string") {
			return {_tag: "Unusable", reason: `line ${index + 1}: ${parsed}`};
		}
		rows.push(parsed);
	}
	const [first, ...rest] = rows;
	return first === undefined
		? {_tag: "Unusable", reason: "no rows were given — an empty readout is not a readout"}
		: {_tag: "Fields", rows: [first, ...rest]};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.rows)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderRows(result.value)} : result;
};
