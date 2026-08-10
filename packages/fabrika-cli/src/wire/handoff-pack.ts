/**
 * The `handoff-pack` document — one GitHub comment carrying a session's handoff to its successor.
 *
 *     <!-- fabrika:handoff pack nonce=7f3a9c21 sealedAt=… groundDigest=f9d0814b89b4 -->
 *
 *     ## Intent / ## Established / ## Next act / ## Unsure      ← the asserted half, the model's words
 *     ## Ground state — proven                                  ← one fenced JSON object, derived
 *
 * It is registered here because it crosses the widest boundary in the corpus — one session to
 * another that shares no memory, no worktree and possibly no machine — and `WireRead`'s three
 * answers are what that boundary needs: **a malformed pack must never read as an absent one**, or a
 * successor concludes nobody handed off and starts over.
 *
 * **The section set is closed, and that is the whole injection defence.** A fifth heading, prose
 * before the first heading, or text after the JSON fence is `Malformed`, never tolerated: an
 * artifact whose section set is open lets an author append a paragraph a successor reads as part of
 * the format, and the successor cannot tell the format's own words from someone else's. The
 * discipline is `./slice-handoff.ts`'s; the posture is its inverse — that brief is machine-local by
 * construction and never posted, this document is posted by definition and carries no local path.
 *
 * This module owns the **bytes** and nothing else. What the proven half's nineteen fields mean, and
 * whether `groundDigest` agrees with them, is `../handoff/ground.ts`'s — so the digest arrives here
 * as a field rather than being recomputed, and a disagreement is a finding the group raises.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const PACK_NONCE: unique symbol;
declare const INSTANT: unique symbol;
declare const GROUND_DIGEST: unique symbol;

/** A run's key: exactly eight lowercase hex characters, authored by the caller. */
export type PackNonce = string & {readonly [PACK_NONCE]: true};
/** An ISO-8601 UTC instant with a trailing `Z`. Branded so `Found` cannot carry `"yesterday"`. */
export type Instant = string & {readonly [INSTANT]: true};
/** Exactly twelve lowercase hex — `bodyDigest`'s width. */
export type GroundDigest = string & {readonly [GROUND_DIGEST]: true};

const NONCE_RE = /^[0-9a-f]{8}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DIGEST_RE = /^[0-9a-f]{12}$/;

export const packNonce = (raw: string): PackNonce | null => {
	const value = raw.trim();
	return NONCE_RE.test(value) ? (value as PackNonce) : null;
};

export const instant = (raw: string): Instant | null => {
	const value = raw.trim();
	return INSTANT_RE.test(value) ? (value as Instant) : null;
};

export const groundDigest = (raw: string): GroundDigest | null => {
	const value = raw.trim();
	return DIGEST_RE.test(value) ? (value as GroundDigest) : null;
};

export interface HandoffPack {
	readonly nonce: PackNonce;
	readonly sealedAt: Instant;
	readonly groundDigest: GroundDigest;
	readonly intent: string;
	readonly established: string;
	readonly nextAct: string;
	readonly unsure: string;
	/** The proven half's fenced JSON, verbatim. One object; its fields are the group's to read. */
	readonly groundJson: string;
}

export type HandoffPackRead = WireRead<HandoffPack>;

/** The four sections the caller writes, in the order the format emits them. */
export const ASSERTED_SECTIONS = ["Intent", "Established", "Next act", "Unsure"] as const;
/** The one section the verb writes. Its em dash is part of the heading, not decoration. */
export const GROUND_SECTION = "Ground state — proven";
/** The closed set. Content under any other heading is a refusal on the way in and on the way out. */
export const SECTIONS = [...ASSERTED_SECTIONS, GROUND_SECTION] as ReadonlyArray<string>;

const MARKER_REACH = /^<!--\s*fabrika:handoff\s+pack\b/;
const MARKER =
	/^<!--\s*fabrika:handoff\s+pack\s+nonce=(\S+)\s+sealedAt=(\S+)\s+groundDigest=(\S+)\s*-->$/;

export const composeMarker = (fields: {
	readonly nonce: PackNonce;
	readonly sealedAt: Instant;
	readonly groundDigest: GroundDigest;
}): string =>
	`<!-- fabrika:handoff pack nonce=${fields.nonce} sealedAt=${fields.sealedAt} groundDigest=${fields.groundDigest} -->`;

export const emit = (pack: HandoffPack): string =>
	[
		composeMarker(pack),
		"",
		"## Intent",
		pack.intent.trim(),
		"",
		"## Established",
		pack.established.trim(),
		"",
		"## Next act",
		pack.nextAct.trim(),
		"",
		"## Unsure",
		pack.unsure.trim(),
		"",
		`## ${GROUND_SECTION}`,
		"```json",
		pack.groundJson.trim(),
		"```",
		"",
	].join("\n");

const firstNonBlankLine = (artifact: string): string | null =>
	artifact.split("\n").find((line) => line.trim() !== "") ?? null;

/** Whether the bytes reach for this format at all — the gate that keeps `Absent` off a real drift. */
export const reaches = (artifact: string): boolean =>
	MARKER_REACH.test((firstNonBlankLine(artifact) ?? "").trim());

const malformed = (reason: string, evidence: string): HandoffPackRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

const HEADING = /^##\s+(.*\S)\s*$/;

interface Section {
	readonly name: string;
	readonly lines: ReadonlyArray<string>;
}

interface Scan {
	readonly sections: ReadonlyArray<Section>;
	/** The first non-blank line sitting under no heading — text that instructs outside the format. */
	readonly stray: string | null;
}

const sectionsOf = (lines: ReadonlyArray<string>): Scan => {
	const sections: {name: string; lines: string[]}[] = [];
	let stray: string | null = null;
	for (const raw of lines) {
		const heading = HEADING.exec(raw);
		if (heading?.[1] !== undefined) {
			sections.push({name: heading[1], lines: []});
			continue;
		}
		const current = sections.at(-1);
		if (current === undefined) {
			if (raw.trim() !== "" && stray === null) stray = raw.trim();
			continue;
		}
		current.lines.push(raw);
	}
	return {sections, stray};
};

const body = (section: Section): string => section.lines.join("\n").trim();

/**
 * The JSON a `## Ground state — proven` section holds, or why it holds none.
 *
 * One fence, one object, nothing beside it. Text after the closing fence is content outside the
 * format's own words, which is the case the closed section set exists to refuse.
 */
export const groundJsonOf = (
	section: string,
):
	| {readonly _tag: "Json"; readonly text: string}
	| {readonly _tag: "No"; readonly reason: string} => {
	const lines = section.split("\n");
	const open = lines.findIndex((line) => line.trim().startsWith("```"));
	if (open === -1) return {_tag: "No", reason: "the proven half carries no fenced JSON block"};
	if (lines.slice(0, open).some((line) => line.trim() !== "")) {
		return {_tag: "No", reason: "the proven half carries prose before its fence"};
	}
	const close = lines.findIndex((line, index) => index > open && line.trim() === "```");
	if (close === -1) return {_tag: "No", reason: "the proven half's fence is never closed"};
	if (lines.slice(close + 1).some((line) => line.trim() !== "")) {
		return {_tag: "No", reason: "the proven half carries text after its fence"};
	}
	const text = lines
		.slice(open + 1, close)
		.join("\n")
		.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {_tag: "No", reason: "the proven half's fence does not hold JSON"};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {_tag: "No", reason: "the proven half's JSON is not one object"};
	}
	return {_tag: "Json", text};
};

export const read = (artifact: string): HandoffPackRead => {
	const line = firstNonBlankLine(artifact);
	if (line === null || !reaches(artifact)) {
		return {
			_tag: "Absent",
			reason:
				'the first non-blank line does not open with "<!-- fabrika:handoff pack" — these bytes are not a pack',
		};
	}
	const evidence = `first line: "${line.trim()}"`;
	const matched = MARKER.exec(line.trim());
	if (matched === null) {
		return malformed(
			'the marker is not "<!-- fabrika:handoff pack nonce=… sealedAt=… groundDigest=… -->" — a field is missing or the grammar drifted',
			evidence,
		);
	}
	const nonce = packNonce(matched[1] ?? "");
	if (nonce === null) {
		return malformed(
			`"${matched[1]}" is not a run nonce — expected exactly eight lowercase hex characters`,
			evidence,
		);
	}
	const sealedAt = instant(matched[2] ?? "");
	if (sealedAt === null) {
		return malformed(`"${matched[2]}" is not an ISO-8601 UTC instant with a trailing Z`, evidence);
	}
	const digest = groundDigest(matched[3] ?? "");
	if (digest === null) {
		return malformed(
			`"${matched[3]}" is not a ground digest — expected 12 lowercase hex`,
			evidence,
		);
	}

	const afterMarker = artifact.split("\n");
	const markerAt = afterMarker.findIndex((raw) => raw.trim() === line.trim());
	const {sections, stray} = sectionsOf(afterMarker.slice(markerAt + 1));
	if (stray !== null) {
		return malformed(
			"the pack carries text outside its five sections — the section set is closed so a successor can tell the format's words from someone else's",
			`"${stray}"`,
		);
	}
	const unknown = sections.find((section) => !SECTIONS.includes(section.name));
	if (unknown !== undefined) {
		return malformed(
			`"## ${unknown.name}" is not a section of this format — the section set is closed`,
			`"## ${unknown.name}"`,
		);
	}
	const names = sections.map((section) => section.name);
	if (names.join(" ") !== SECTIONS.join(" ")) {
		return malformed(
			`the five sections are ${SECTIONS.map((name) => `## ${name}`).join(", ")}, in that order — this pack carries ${names.length === 0 ? "none" : names.map((name) => `## ${name}`).join(", ")}`,
			names.map((name) => `## ${name}`).join(" | "),
		);
	}
	const empty = sections.find((section) => body(section) === "");
	if (empty !== undefined) {
		return malformed(
			`"## ${empty.name}" is empty — an empty section is not an absent one`,
			`## ${empty.name}`,
		);
	}

	const ground = sections.at(-1);
	if (ground === undefined) {
		return malformed("the pack carries no proven half", `## ${GROUND_SECTION}`);
	}
	const json = groundJsonOf(body(ground));
	if (json._tag === "No") return malformed(json.reason, `## ${GROUND_SECTION}`);

	const [intent, established, nextAct, unsure] = sections;
	if (
		intent === undefined ||
		established === undefined ||
		nextAct === undefined ||
		unsure === undefined
	) {
		// Unreachable: the order check above already proved all five are present, in order.
		return malformed("the asserted half is incomplete", "## Intent");
	}
	return {
		_tag: "Found",
		value: {
			nonce,
			sealedAt,
			groundDigest: digest,
			intent: body(intent),
			established: body(established),
			nextAct: body(nextAct),
			unsure: body(unsure),
			groundJson: json.text,
		},
	};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderPack = (pack: HandoffPack): NonEmptyReadonlyArray<string> => [
	`nonce\t${pack.nonce}`,
	`sealedAt\t${pack.sealedAt}`,
	`groundDigest\t${pack.groundDigest}`,
	...pack.intent.split("\n").map((text) => `intent\t${text}`),
	...pack.established.split("\n").map((text) => `established\t${text}`),
	...pack.nextAct.split("\n").map((text) => `nextAct\t${text}`),
	...pack.unsure.split("\n").map((text) => `unsure\t${text}`),
	`ground\t${pack.groundJson.replace(/\n/g, " ")}`,
];

export type HandoffPackFields =
	| {readonly _tag: "Fields"; readonly pack: HandoffPack}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD = /^([a-zA-Z]+):\s*(.*)$/;

/**
 * Parse `emit`'s stdin: `nonce` / `sealedAt` / `groundDigest` / `ground` one per line, then
 * `asserted:` whose block runs to the end and holds the four sections.
 *
 * Every rejection is a refusal rather than a default — a pack composed with a field silently missing
 * is a pack whose successor works from less than the author wrote.
 */
export const parseFields = (fields: string): HandoffPackFields => {
	const values = new Map<string, string>();
	const asserted: string[] = [];
	let inAsserted = false;
	for (const [index, raw] of fields.split("\n").entries()) {
		if (inAsserted) {
			asserted.push(raw);
			continue;
		}
		const line = raw.trim();
		if (line === "") continue;
		const field = FIELD.exec(line);
		if (field?.[1] === undefined) {
			return {_tag: "Unusable", reason: `line ${index + 1} is not a "<field>: <value>" line`};
		}
		if (field[1] === "asserted") {
			inAsserted = true;
			continue;
		}
		values.set(field[1], field[2] ?? "");
	}

	const nonce = packNonce(values.get("nonce") ?? "");
	if (nonce === null) return {_tag: "Unusable", reason: "no eight-lowercase-hex nonce"};
	const sealedAt = instant(values.get("sealedAt") ?? "");
	if (sealedAt === null) return {_tag: "Unusable", reason: "no ISO-8601 UTC sealedAt"};
	const digest = groundDigest(values.get("groundDigest") ?? "");
	if (digest === null) return {_tag: "Unusable", reason: "no 12-lowercase-hex groundDigest"};
	const json = groundJsonOf(["```json", (values.get("ground") ?? "").trim(), "```"].join("\n"));
	if (json._tag === "No") return {_tag: "Unusable", reason: `ground: ${json.reason}`};

	const {sections, stray} = sectionsOf(asserted);
	if (stray !== null) {
		return {
			_tag: "Unusable",
			reason: `the asserted half carries text outside its sections: "${stray}"`,
		};
	}
	const names = sections.map((section) => section.name);
	if (names.join(" ") !== ASSERTED_SECTIONS.join(" ")) {
		return {
			_tag: "Unusable",
			reason: `the asserted half is ${ASSERTED_SECTIONS.map((name) => `## ${name}`).join(", ")}, in that order`,
		};
	}
	const [intent, established, nextAct, unsure] = sections;
	if (
		intent === undefined ||
		established === undefined ||
		nextAct === undefined ||
		unsure === undefined
	) {
		// Unreachable: the order check above proved all four are present.
		return {_tag: "Unusable", reason: "the asserted half is incomplete"};
	}
	for (const section of sections) {
		if (body(section) === "") {
			return {_tag: "Unusable", reason: `"## ${section.name}" is empty`};
		}
	}
	return {
		_tag: "Fields",
		pack: {
			nonce,
			sealedAt,
			groundDigest: digest,
			intent: body(intent),
			established: body(established),
			nextAct: body(nextAct),
			unsure: body(unsure),
			groundJson: json.text,
		},
	};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.pack)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderPack(result.value)} : result;
};
