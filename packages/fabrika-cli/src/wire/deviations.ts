/**
 * The PR body's `## Deviations` section — the one place its grammar is stated.
 *
 * The section had two contracts that disagreed: `build pr` asked only that the heading exist with
 * something under it, while the review reader dropped every bullet carrying no `Said` field and then
 * called a section of zero surviving entries `malformed`. A body that fully satisfied the producer
 * was therefore guaranteed to fail the consumer closed, and no author-facing doc stated the field
 * grammar either side was judging against (#5566). Registering the section as a wire format is what
 * makes that disagreement unrepresentable: one module owns the bytes, and both sides read it.
 *
 * `read` is total, and `Found` carries a {@link DeviationsDisclosure} rather than a bare list,
 * because this section has **four** meanings where the wire has three answers. `None.` is a checked
 * claim — an author who considered the question and has nothing to disclose — and folding it into
 * `Absent` is how "never considered it" comes to read as "nothing to disclose". So `None.` is a
 * `Found` of its own tag, and `Absent` stays reserved for a body with no such heading at all.
 *
 * An entry carries all four fields. The reader required `Said` alone and the class label is a
 * routing hint, but a disclosure missing *Why* or *Disposition* states what changed without stating
 * whether anyone accepted it — so the refusal now names the missing field at the point the body is
 * written, instead of costing a review round that could not say what was wrong.
 *
 * v1's §DEV supplied the semantics — the four fields, the seven classes, the M/R/D tiers — and was
 * read as prior art, never called (ADR 0238).
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const FIELD_TEXT: unique symbol;

/**
 * One field's value, collapsed to a single line and non-blank.
 *
 * Branded for the reason `CriterionText` is: `**Said:**` with nothing after it is not a disclosure,
 * and a `Found` carrying one would be a well-formed answer that discloses nothing.
 */
export type FieldText = string & {readonly [FIELD_TEXT]: true};

/**
 * A field's value as the answer carries it: interior whitespace runs — including the newlines a
 * wrapped field is authored across — collapsed to one space, so no field spans two output lines.
 */
export const fieldText = (raw: string): FieldText | null => {
	const value = raw.replace(/\s+/g, " ").trim();
	return value === "" ? null : (value as FieldText);
};

/** The seven classes. A label outside this set is not a drift — it costs a `-` and nothing else. */
export const CLASSES: ReadonlyArray<readonly [string, string]> = [
	["1", "Scope narrowing"],
	["2", "Governing-ADR departure"],
	["3", "Known defect left unfixed"],
	["4", "Declined guidance"],
	["5", "Guard or gate bypassed"],
	["6", "Pre-existing test or fixture changed"],
	["7", "Out-of-scope change"],
];

/** The four fields, in the order an entry states them. The grammar, as data. */
export const FIELDS = ["said", "did", "why", "disposition"] as const;
export type FieldKey = (typeof FIELDS)[number];

/** How an entry writes a field's name — `**Said:**`, the canonical §DEV spelling. */
export const fieldLabel = (key: FieldKey): string => key.charAt(0).toUpperCase() + key.slice(1);

export interface DeviationEntry {
	/** The class label `1`–`7`, or `null` when the entry carries none this reader recognises. */
	readonly label: string | null;
	/** What the spec asked. */
	readonly said: FieldText;
	/** What was built instead. */
	readonly did: FieldText;
	/** Why the departure was taken. */
	readonly why: FieldText;
	/** What now becomes of it — stated, filed, accepted. */
	readonly disposition: FieldText;
}

/**
 * What the section discloses. `NoneDeclared` is a *claim*, not an empty list — which is why it is a
 * tag here rather than an entries array of length zero.
 */
export type DeviationsDisclosure =
	| {readonly _tag: "NoneDeclared"}
	| {readonly _tag: "Entries"; readonly entries: NonEmptyReadonlyArray<DeviationEntry>};

export type DeviationsRead = WireRead<DeviationsDisclosure>;

/** The one conforming heading. Level and spelling are both part of it. */
export const HEADING_LEVEL = 2;
export const HEADING_TEXT = "Deviations";

/** The literal body that declares nothing to disclose. */
export const NONE_TEXT = "None.";

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const BULLET = /^[ \t]{0,3}[-*][ \t]+/;
const NONE_RE = /^none\.?$/i;
const FIELD_MARKER = /\*{0,2}(said|did|why|disposition)\*{0,2}[ \t]*:[ \t]*\*{0,2}/gi;

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Heading {
	readonly level: number;
	readonly text: string;
	/** 1-based, so a refusal can point at a line a human can find. */
	readonly line: number;
}

/** Every ATX heading outside a fenced block — a fenced example must not pass for the real one. */
const scanHeadings = (lines: ReadonlyArray<string>): ReadonlyArray<Heading> => {
	const headings: Heading[] = [];
	let openFence: string | null = null;
	for (const [index, line] of lines.entries()) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			continue;
		}
		if (openFence !== null) continue;
		const heading = ATX_HEADING.exec(line);
		if (heading === null) continue;
		headings.push({level: (heading[1] ?? "").length, text: heading[2] ?? "", line: index + 1});
	}
	return headings;
};

/**
 * Does this heading reach for the section at all?
 *
 * Wider than the conforming form on purpose: every heading admitted and then rejected becomes a
 * `Malformed` naming the drift, and every one turned away becomes an `Absent`. Erring wide is what
 * keeps `## deviations` from being reported as "the author never wrote the section".
 */
const reachesForBlock = (text: string): boolean => normalize(text).includes("deviation");

const conforms = (heading: Heading): boolean =>
	heading.level === HEADING_LEVEL && heading.text === HEADING_TEXT;

const quote = (heading: Heading): string =>
	`line ${heading.line}: "${"#".repeat(heading.level)} ${heading.text}"`;

const driftReason = (heading: Heading): string => {
	const parts = [
		heading.level === HEADING_LEVEL
			? null
			: `heading level ${heading.level}, expected ${HEADING_LEVEL}`,
		heading.text === HEADING_TEXT
			? null
			: `heading text "${heading.text}", expected "${HEADING_TEXT}"`,
	].filter((part): part is string => part !== null);
	return `the deviations heading has drifted — ${parts.join("; ")}`;
};

/** The lines under `heading`, up to the next heading outside a fence, or the end of the body. */
const sectionOf = (lines: ReadonlyArray<string>, heading: Heading): ReadonlyArray<string> => {
	const body: string[] = [];
	let openFence: string | null = null;
	for (const line of lines.slice(heading.line)) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			body.push(line);
			continue;
		}
		if (openFence === null && ATX_HEADING.test(line)) break;
		body.push(line);
	}
	return body;
};

/**
 * Each top-level bullet in the section, joined with its continuation lines.
 *
 * An entry spans several lines in practice — four fields do not fit one 100-column line — so a
 * per-line read would report one entry as four and lose every field that started on a later line.
 */
const bulletsOf = (section: ReadonlyArray<string>): ReadonlyArray<string> => {
	const bullets: string[] = [];
	for (const line of section) {
		if (BULLET.test(line)) bullets.push(line.replace(BULLET, ""));
		else if (bullets.length > 0 && line.trim() !== "") bullets[bullets.length - 1] += `\n${line}`;
	}
	return bullets;
};

/** The bold or plain lead of a bullet — `**Scope narrowing**` — before the first field. */
const leadOf = (bullet: string): string => {
	const bold = /^\s*\*\*(.+?)\*\*/.exec(bullet);
	if (bold?.[1] !== undefined) return bold[1];
	return bullet.split(/[—–:]/)[0] ?? "";
};

const labelOf = (lead: string): string | null => {
	const key = normalize(lead);
	const named = CLASSES.find(([, name]) => key.startsWith(normalize(name)));
	if (named !== undefined) return named[0];
	return /^([1-7])\b/.exec(lead.trim())?.[1] ?? null;
};

/**
 * Each field's raw slice — from the end of its own marker to the start of the next field's.
 *
 * The emphasis is admitted on both sides of the colon: the canonical entry writes `**Said:**`,
 * closing the bold *after* the punctuation, so a pattern anchored only on `**Said**:` would leave
 * the closer at the head of every value it read.
 */
const slicesOf = (bullet: string): ReadonlyMap<FieldKey, string> => {
	const marks: Array<{readonly key: FieldKey; readonly from: number; readonly at: number}> = [];
	FIELD_MARKER.lastIndex = 0;
	for (const match of bullet.matchAll(FIELD_MARKER)) {
		const key = (match[1] ?? "").toLowerCase() as FieldKey;
		marks.push({key, at: match.index, from: match.index + match[0].length});
	}
	const slices = new Map<FieldKey, string>();
	for (const [index, mark] of marks.entries()) {
		if (slices.has(mark.key)) continue;
		const end = marks[index + 1]?.at ?? bullet.length;
		slices.set(mark.key, bullet.slice(mark.from, end));
	}
	return slices;
};

const malformed = (reason: string, evidence: string): DeviationsRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** One bullet as an entry, or the reason it is not one. */
const entryOf = (
	bullet: string,
):
	| {readonly _tag: "Entry"; readonly entry: DeviationEntry}
	| {readonly _tag: "Bad"; readonly reason: string} => {
	const slices = slicesOf(bullet);
	const values = new Map<FieldKey, FieldText>();
	const missing: string[] = [];
	for (const key of FIELDS) {
		const value = fieldText(slices.get(key) ?? "");
		if (value === null) missing.push(`**${fieldLabel(key)}:**`);
		else values.set(key, value);
	}
	if (missing.length > 0) {
		return {
			_tag: "Bad",
			reason: `an entry carries no ${missing.join(", ")} — every entry states ${FIELDS.map((key) => `**${fieldLabel(key)}:**`).join(" / ")}`,
		};
	}
	const [said, did, why, disposition] = FIELDS.map((key) => values.get(key));
	if (said === undefined || did === undefined || why === undefined || disposition === undefined) {
		return {_tag: "Bad", reason: "an entry lost a field between reading it and building it"};
	}
	return {
		_tag: "Entry",
		entry: {label: labelOf(leadOf(bullet)), said, did, why, disposition},
	};
};

/** Read the `## Deviations` section out of a PR body. Total: `Found` | `Absent` | `Malformed`. */
export const read = (body: string): DeviationsRead => {
	const lines = body.split("\n");
	const candidates = scanHeadings(lines).filter((heading) => reachesForBlock(heading.text));
	const first = candidates[0];
	if (first === undefined) {
		return {
			_tag: "Absent",
			reason: `no heading in the body reaches for "${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}"`,
		};
	}

	const conforming = candidates.filter(conforms);
	if (conforming.length === 0) return malformed(driftReason(first), quote(first));
	if (conforming.length > 1) {
		return malformed(
			`the body carries ${conforming.length} deviations headings — which one is the disclosure is undecidable`,
			conforming.map(quote).join(" | "),
		);
	}

	const heading = conforming[0];
	if (heading === undefined) return malformed("the deviations heading could not be resolved", "");

	const section = sectionOf(lines, heading);
	const text = section.join("\n").trim();
	if (text === "") {
		return malformed(
			`"${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}" is present and its section is empty — state a deviation, or state "${NONE_TEXT}"`,
			`line ${heading.line}`,
		);
	}
	if (NONE_RE.test(text)) return {_tag: "Found", value: {_tag: "NoneDeclared"}};

	const entries: DeviationEntry[] = [];
	for (const bullet of bulletsOf(section)) {
		const parsed = entryOf(bullet);
		if (parsed._tag === "Bad") {
			return malformed(parsed.reason, `line ${heading.line}: "${bullet.split("\n")[0] ?? ""}"`);
		}
		entries.push(parsed.entry);
	}

	const [head, ...rest] = entries;
	if (head === undefined) {
		return malformed(
			`"${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}" is present and its section holds no "- " entry — state a deviation, or state "${NONE_TEXT}"`,
			`line ${heading.line}`,
		);
	}
	return {_tag: "Found", value: {_tag: "Entries", entries: [head, ...rest]}};
};

const entryLine = (entry: DeviationEntry): string => {
	const lead = CLASSES.find(([label]) => label === entry.label)?.[1] ?? null;
	const fields = FIELDS.map((key) => `**${fieldLabel(key)}:** ${entry[key]}`).join(" ");
	return lead === null ? `- ${fields}` : `- **${lead}** — ${fields}`;
};

/** Compose the section's bytes. Round-trips through {@link read}. */
export const emit = (disclosure: DeviationsDisclosure): string => {
	const heading = `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}`;
	const body =
		disclosure._tag === "NoneDeclared" ? NONE_TEXT : disclosure.entries.map(entryLine).join("\n");
	return `${heading}\n\n${body}\n`;
};

export type DeviationsFields =
	| {readonly _tag: "Fields"; readonly disclosure: DeviationsDisclosure}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** The null label on stdin and in the answer — the same token `review verdicts` uses. */
export const NULL_LABEL = "-";

/**
 * Parse `emit`'s stdin: the literal `None.`, or one tab-separated entry per line —
 * `<label-or-->\t<said>\t<did>\t<why>\t<disposition>`.
 *
 * Every rejection is a refusal rather than a default. A dropped field that silently composed a
 * three-field entry would emit bytes this format's own reader then calls malformed.
 */
export const parseFields = (fields: string): DeviationsFields => {
	if (NONE_RE.test(fields.trim())) {
		return {_tag: "Fields", disclosure: {_tag: "NoneDeclared"}};
	}
	const entries: DeviationEntry[] = [];
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const columns = line.split("\t");
		if (columns.length !== FIELDS.length + 1) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} carries ${columns.length} tab-separated columns, expected ${FIELDS.length + 1}: <label-or-${NULL_LABEL}>\t${FIELDS.join("\t")}`,
			};
		}
		const values = FIELDS.map((key, at) => [key, fieldText(columns[at + 1] ?? "")] as const);
		const blank = values.filter(([, value]) => value === null).map(([key]) => key);
		if (blank.length > 0) {
			return {_tag: "Unusable", reason: `line ${index + 1} carries no ${blank.join(", ")}`};
		}
		const [said, did, why, disposition] = values.map(([, value]) => value);
		if (
			said === undefined ||
			said === null ||
			did === undefined ||
			did === null ||
			why === undefined ||
			why === null ||
			disposition === undefined ||
			disposition === null
		) {
			return {_tag: "Unusable", reason: `line ${index + 1} lost a field after it was read`};
		}
		const label = (columns[0] ?? "").trim();
		entries.push({
			label: label === NULL_LABEL || label === "" ? null : (labelOf(label) ?? null),
			said,
			did,
			why,
			disposition,
		});
	}
	const [head, ...rest] = entries;
	if (head === undefined) {
		return {
			_tag: "Unusable",
			reason: `no entry lines — an empty section is malformed; state "${NONE_TEXT}" to declare nothing`,
		};
	}
	return {_tag: "Fields", disclosure: {_tag: "Entries", entries: [head, ...rest]}};
};

/** The `wire read` answer for this format: `none-declared`, or one line per entry. */
export const renderDisclosure = (
	disclosure: DeviationsDisclosure,
): NonEmptyReadonlyArray<string> => {
	if (disclosure._tag === "NoneDeclared") return ["none-declared"];
	const line = (entry: DeviationEntry): string =>
		["entry", entry.label ?? NULL_LABEL, ...FIELDS.map((key) => entry[key])].join("\t");
	const [head, ...rest] = disclosure.entries;
	return [line(head), ...rest.map(line)];
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.disclosure)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderDisclosure(result.value)} : result;
};
