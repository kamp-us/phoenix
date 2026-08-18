/**
 * The `## Came from` section — the one line saying which issue an artifact's question arrived from,
 * and the only thing carrying a wayfinding frontier ticket number into a sibling skill.
 *
 *     ## Came from
 *
 *     #5652
 *
 * Both siblings `map fork` routes to write it: `spike open` records it on the spike issue and
 * `grill open` records it on the session issue, where it is also the resume key. Two writers and
 * two readers across two skills is a wire format, so it is owned here rather than by either group
 * (ADR 0241).
 *
 * **`standalone` is a value, not an absence.** An artifact opened with no ticket writes the literal
 * word, so "nobody bound this" is something the section says rather than something a reader infers
 * from a blank.
 *
 * **The section is provenance, never instruction.** A number here says where the question came
 * from; it grants nothing, and no verb reads the named issue for direction.
 *
 * The reason `read` is total matters more here than almost anywhere else in the group. This
 * section's `Found` decides whether a session already exists for a ticket, so a drifted heading
 * answered as "bound to nothing" would resume nothing and mint a **second** session on one ticket —
 * the split #5661 was filed about, except silent, where the failure it replaced was at least a
 * visibly duplicate topic. `Malformed` is what makes the caller refuse instead of resume.
 */

import {type Heading, scanHeadings} from "./acceptance-criteria.ts";
import type {
	NonEmptyReadonlyArray,
	WireEmit,
	WireMalformed,
	WireRead,
	WireReadLines,
} from "./format.ts";

/** The one conforming heading. Level and spelling are both part of it. */
export const HEADING_LEVEL = 2;
export const HEADING_TEXT = "Came from";

/** The heading as it is written. Kept as one string for the writers that compose the section. */
export const CAME_FROM_HEADING = `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}`;

/** What an unbound artifact records. A blank value would read as a section nobody filled in. */
export const STANDALONE = "standalone";

declare const BINDING: unique symbol;

/**
 * The section's value line, exactly as it conforms: `#<n>`, or the literal `standalone`.
 *
 * Branded because those two forms are the whole inhabited set. A bare `string` here would let a
 * caller hold `"the founder mentioned it on a call"` as a binding, which is precisely the value the
 * read refuses — and {@link ticketOf} would then have to answer something about it.
 */
export type CameFromBinding = string & {readonly [BINDING]: true};

const TICKET_LINE = /^#([0-9]+)$/;

/** The binding a value line carries, or `null` when the line is neither form. */
export const cameFromBinding = (raw: string): CameFromBinding | null => {
	const value = raw.trim();
	return value === STANDALONE || TICKET_LINE.test(value) ? (value as CameFromBinding) : null;
};

/** What the section says. One field, because the section is one line. */
export interface CameFrom {
	readonly binding: CameFromBinding;
}

export type CameFromRead = WireRead<CameFrom>;

/**
 * The ticket a binding names, or `null` for a **proven standalone** artifact.
 *
 * This `null` is safe where the old reader's was not: it is only reachable from a `Found`, so it
 * says "this artifact records that it came from nowhere" and never "I could not tell".
 */
export const ticketOf = (binding: CameFromBinding): number | null => {
	const matched = TICKET_LINE.exec(binding);
	return matched === null ? null : Number.parseInt(matched[1] ?? "0", 10);
};

/** The section's value line for a ticket, or for nothing. */
export const renderCameFrom = (ticket: number | null): CameFromBinding =>
	(ticket === null ? STANDALONE : `#${ticket}`) as CameFromBinding;

/** The whole section, heading and value, ending in one newline. */
export const cameFromSection = (ticket: number | null): string =>
	`${CAME_FROM_HEADING}\n\n${renderCameFrom(ticket)}\n`;

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADING_KEY = normalize(HEADING_TEXT);

/**
 * Does this heading reach for the section?
 *
 * Deliberately wider than the conforming form, for the reason `./acceptance-criteria.ts` states at
 * length: every heading admitted here and then rejected becomes a `Malformed` naming the drift, and
 * every one turned away becomes an `Absent`. Erring wide is what keeps `## Came From` from being
 * reported as "this session came from nowhere".
 */
const reachesForBlock = (headingText: string): boolean =>
	normalize(headingText).includes(HEADING_KEY);

const conforms = (heading: Heading): boolean =>
	heading.level === HEADING_LEVEL && heading.text === HEADING_TEXT;

const quote = (heading: Heading): string =>
	`line ${heading.line}: "${"#".repeat(heading.level)} ${heading.text}"`;

const malformed = (reason: string, evidence: string): WireMalformed => ({
	_tag: "Malformed",
	reason,
	evidence,
});

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+/;

/** The first non-blank line under `heading`, before the next heading, or `null`. */
const valueLineOf = (
	lines: ReadonlyArray<string>,
	heading: Heading,
): {readonly text: string; readonly line: number} | null => {
	for (const [offset, line] of lines.slice(heading.line).entries()) {
		if (ATX_HEADING.test(line)) return null;
		if (line.trim() !== "") return {text: line.trim(), line: heading.line + offset + 1};
	}
	return null;
};

/** Read the section out of an artifact body. Total: `Found` | `Absent` | `Malformed`. */
export const read = (body: string): CameFromRead => {
	const lines = body.split("\n");
	const candidates = scanHeadings(lines).filter((heading) => reachesForBlock(heading.text));
	if (candidates.length === 0) {
		return {
			_tag: "Absent",
			reason: `no heading in the body reaches for "${CAME_FROM_HEADING}"`,
		};
	}

	const conforming = candidates.filter(conforms);
	const first = candidates[0];
	if (conforming.length === 0 && first !== undefined) {
		const parts = [
			first.level === HEADING_LEVEL
				? null
				: `heading level ${first.level}, expected ${HEADING_LEVEL}`,
			first.text === HEADING_TEXT
				? null
				: `heading text "${first.text}", expected "${HEADING_TEXT}"`,
		].filter((part): part is string => part !== null);
		return malformed(`the came-from heading has drifted — ${parts.join("; ")}`, quote(first));
	}
	if (conforming.length > 1) {
		return malformed(
			`the body carries ${conforming.length} came-from headings — which one is the binding is undecidable`,
			conforming.map(quote).join(" | "),
		);
	}

	const heading = conforming[0];
	if (heading === undefined) return malformed("the came-from heading could not be resolved", "");

	const value = valueLineOf(lines, heading);
	if (value === null) {
		return malformed(
			`"${CAME_FROM_HEADING}" is present and its section is empty — a section nobody filled in binds nothing`,
			quote(heading),
		);
	}
	const binding = cameFromBinding(value.text);
	if (binding === null) {
		return malformed(
			`"${value.text}" is not a binding — expected "#<issue>" or the literal "${STANDALONE}"`,
			`line ${value.line}: "${value.text}"`,
		);
	}
	return {_tag: "Found", value: {binding}};
};

/** Compose the section's bytes. Round-trips through {@link read}. */
export const emit = (cameFrom: CameFrom): string => `${CAME_FROM_HEADING}\n\n${cameFrom.binding}\n`;

/** One `<field>\t<value>` line — the `wire read` answer for this format. */
export const renderBinding = (cameFrom: CameFrom): NonEmptyReadonlyArray<string> => [
	`binding\t${cameFrom.binding}`,
];

export type CameFromFields =
	| {readonly _tag: "Fields"; readonly cameFrom: CameFrom}
	| {readonly _tag: "Unusable"; readonly reason: string};

/** `<key>: <value>` or `<key><TAB><value>`, so `wire read`'s own output pipes back into `wire emit`. */
const FIELD_LINE = /^([A-Za-z-]+)[ \t]*[:\t][ \t]*(.*)$/;

/**
 * Parse `wire emit`'s stdin into the section's value.
 *
 * One field, `binding`, and its value is the line the section carries — `#<n>` or `standalone`. A
 * bare number is refused rather than coerced: `5652` and `#5652` are different bytes, and composing
 * the second from the first is the writer quietly disagreeing with the reader.
 */
export const parseFields = (fields: string): CameFromFields => {
	let seen: string | null = null;
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const matched = FIELD_LINE.exec(line);
		if (matched === null || matched[1]?.toLowerCase() !== "binding") {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} is not a "binding: <value>" line: "${line}"`,
			};
		}
		if (seen !== null) {
			return {
				_tag: "Unusable",
				reason: `"binding" is given twice — which one is the field is undecidable`,
			};
		}
		seen = matched[2] ?? "";
	}
	const binding = cameFromBinding(seen ?? "");
	return binding === null
		? {
				_tag: "Unusable",
				reason: `"${seen ?? ""}" is not a binding — expected "#<issue>" or the literal "${STANDALONE}"`,
			}
		: {_tag: "Fields", cameFrom: {binding}};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.cameFrom)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderBinding(result.value)} : result;
};
