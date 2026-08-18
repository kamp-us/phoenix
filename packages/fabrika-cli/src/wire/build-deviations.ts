/**
 * The `build-deviations` marker comment — an epic child's deviation disclosure, on its own issue.
 *
 *     build-deviations: #5828
 *
 *     ## Deviations
 *
 *     None.
 *
 * A child of an epic run opens no PR (ADR 0285), so the one disclosure surface `build` has — the PR
 * body's `## Deviations` section — does not exist for it. Ruled on #5903: the disclosure lands as a
 * marker comment on the child issue, and the epic-tail review reads it from there.
 *
 * Two parts, each with one owner. The first non-blank line is the marker: `build-deviations:` plus
 * the issue the comment discloses for, so a comment pasted onto the wrong issue is visible as a
 * mismatch rather than silently counted. Everything under it is the `## Deviations` section exactly
 * as a PR body carries it, delegated wholesale to `./deviations.ts` — this module never re-states
 * the entry grammar, because two readers of the four-field bullet is the disagreement that format
 * exists to remove (#5566).
 *
 * The discrimination that carries the weight is **Absent vs Malformed**: bytes with no
 * `build-deviations:` first line are `Absent` — an ordinary comment, not a defective disclosure —
 * while a marker line over a missing or drifted section is `Malformed`, because the marker promised
 * a disclosure and the promise is what a tail reviewer would otherwise count as "nothing to read".
 */

import * as deviations from "./deviations.ts";
import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

export interface BuildDeviations {
	/** The child issue this comment discloses for — the issue the comment sits on. */
	readonly issue: number;
	/** The section's content, owned end to end by `./deviations.ts`. */
	readonly disclosure: deviations.DeviationsDisclosure;
}

export type BuildDeviationsRead = WireRead<BuildDeviations>;

export const KEY_PREFIX = "build-deviations:";
const MARKER = /^build-deviations:\s*#(\d+)\s*$/i;

const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

const malformed = (reason: string, evidence: string): BuildDeviationsRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/** Whether the bytes reach for this format at all — the gate that keeps `Absent` off a real drift. */
export const reaches = (artifact: string): boolean =>
	(firstNonBlankLine(artifact) ?? "").trimStart().toLowerCase().startsWith(KEY_PREFIX);

/** Read the marker comment. Total: `Found` | `Absent` | `Malformed`. */
export const read = (artifact: string): BuildDeviationsRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null || !reaches(artifact)) {
		return {
			_tag: "Absent",
			reason:
				'the first non-blank line does not open with "build-deviations:" — no marker of this format',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	const matched = MARKER.exec(line.trim());
	if (matched === null) {
		return malformed(
			'the marker is not "build-deviations: #<issue>" — the issue the comment discloses for is missing',
			evidence,
		);
	}
	const issue = Number.parseInt(matched[1] ?? "0", 10);

	const lines = artifact.split("\n");
	const rest = lines.slice(lines.findIndex((raw) => raw.trim() !== "") + 1).join("\n");
	const section = deviations.read(rest);
	if (section._tag === "Absent") {
		return malformed(
			`the marker promises a disclosure and no "${"#".repeat(deviations.HEADING_LEVEL)} ${deviations.HEADING_TEXT}" section follows — ${section.reason}`,
			evidence,
		);
	}
	if (section._tag === "Malformed") return section;
	return {_tag: "Found", value: {issue, disclosure: section.value}};
};

/** Compose the comment's bytes. Round-trips through {@link read}. */
export const emit = ({issue, disclosure}: BuildDeviations): string =>
	`${KEY_PREFIX} #${issue}\n\n${deviations.emit(disclosure)}`;

export type BuildDeviationsFields =
	| {readonly _tag: "Fields"; readonly value: BuildDeviations}
	| {readonly _tag: "Unusable"; readonly reason: string};

const ISSUE_LINE = /^issue[ \t]*[:\t][ \t]*(.*)$/i;

/**
 * Parse `emit`'s stdin: an `issue: <n>` first line, then the section's fields exactly as the
 * `deviations` format takes them — the literal `None.`, or one tab-separated entry per line.
 */
export const parseFields = (fields: string): BuildDeviationsFields => {
	const lines = fields.split("\n");
	const at = lines.findIndex((raw) => raw.trim() !== "");
	const head = ISSUE_LINE.exec((lines[at] ?? "").trim());
	if (at === -1 || head === null) {
		return {
			_tag: "Unusable",
			reason: 'the first line is not "issue: <n>" — the disclosure must name the issue it is for',
		};
	}
	const raw = (head[1] ?? "").trim().replace(/^#/, "");
	if (!/^\d+$/.test(raw)) {
		return {_tag: "Unusable", reason: `"${head[1]}" is not an issue number`};
	}
	const section = deviations.parseFields(lines.slice(at + 1).join("\n"));
	if (section._tag === "Unusable") return section;
	return {
		_tag: "Fields",
		value: {issue: Number.parseInt(raw, 10), disclosure: section.disclosure},
	};
};

/** The `wire read` answer for this format: the issue line, then the section's own rendering. */
export const render = (value: BuildDeviations): NonEmptyReadonlyArray<string> => [
	`issue\t${value.issue}`,
	...deviations.renderDisclosure(value.disclosure),
];

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.value)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: render(result.value)} : result;
};
