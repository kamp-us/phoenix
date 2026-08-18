/**
 * The mechanical acceptance-criteria shape repair — the pure core of `triage repair-criteria`.
 *
 * `wire/acceptance-criteria.ts` pins the block's shape: the one conforming heading
 * (`### Acceptance criteria`, level and spelling both part of it) over checkbox items. The board
 * carries hundreds of already-filed bodies that miss it — every one answers `Malformed`, and the
 * review gate may neither hand-parse the block nor invent criteria, so the PR stalls with no verdict
 * at all (#5744; #5565 is the producer-side fix and stops only *new* drift). This module plans the
 * repairs that are pure shape, so safe to automate:
 *
 * 1. a heading whose text is already exactly the conforming text and whose only defect is the
 *    level, rewritten to `###`;
 * 2. items written as plain list bullets under a block that carries no checkbox at all, each
 *    rewritten to an unchecked checkbox with its text byte-for-byte unchanged (#6001).
 *
 * Anything else is refused, never guessed — repairing drifted *text* is indistinguishable from
 * inventing a contract, and so is deciding that a prose paragraph beside the list was meant as a
 * criterion. The bullet conversion is bounded the same way from the other side: a block that
 * already carries one checkbox is left alone, because promoting the remaining bullets there would
 * *add* criteria to a contract that already says something.
 *
 * The plan acts on the **authored region only**. The `<!-- fabrika:enriched … -->` marker (or the
 * legacy v1 envelope) is the boundary `triage enrich`'s own guards rely on, and a `##` heading down
 * inside the preserved original is a historical record — rewriting it would falsify the verbatim
 * block. Classification reads the **whole body**, because that is what the reader grades; since
 * #5852 the reader skips a `<details>` appendix, so a body whose only drift is buried there is
 * `Absent` — nothing to repair, and nothing left un-gateable either.
 */

import {
	type AcceptanceCriterion,
	HEADING_LEVEL,
	HEADING_TEXT,
	type Heading,
	isCheckboxItem,
	read,
	scanHeadings,
	sectionOf,
} from "../wire/acceptance-criteria.ts";
import type {NonEmptyReadonlyArray} from "../wire/format.ts";
import {MARKER_RE} from "./enrich.ts";

/** One shape defect this module repaired, with the lines it touched. Line numbers are 1-based. */
export type CriteriaRepair =
	| {readonly _tag: "HeadingLevel"; readonly line: number; readonly fromLevel: number}
	| {readonly _tag: "BulletItems"; readonly lines: NonEmptyReadonlyArray<number>};

/** What a repair did, for the verb's diagnostic line. */
export const describeRepair = (repair: CriteriaRepair): string =>
	repair._tag === "HeadingLevel"
		? `line ${repair.line}: level ${repair.fromLevel} → ${HEADING_LEVEL}`
		: `line${repair.lines.length === 1 ? "" : "s"} ${repair.lines.join(", ")}: ${
				repair.lines.length
			} plain bullet${repair.lines.length === 1 ? "" : "s"} → unchecked checkbox${
				repair.lines.length === 1 ? "" : "es"
			}`;

export type CriteriaRepairPlan =
	/** The shape rewritten; `body` is the whole repaired body, verified through `read`. */
	| {
			readonly _tag: "Repaired";
			readonly body: string;
			/** Every defect rewritten, located in the body as it was. */
			readonly repairs: NonEmptyReadonlyArray<CriteriaRepair>;
			/** What the repaired body reads back as — the criteria the drifted body carried all along. */
			readonly criteria: NonEmptyReadonlyArray<AcceptanceCriterion>;
	  }
	/** The reader already answers `Found`; there is nothing to repair. */
	| {readonly _tag: "AlreadyConforming"}
	/** The reader answers `Absent`; a body with no block at all is a fact, not a defect. */
	| {readonly _tag: "NoBlock"}
	/** `Malformed`, but not a pure level drift in the authored region — refuse, naming what was read. */
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * The bytes this repair may touch and the bytes it must not, split at the same boundary
 * `triage enrich` writes and reads back.
 *
 * A marker bound to a *different* issue is a pasted body and reads as authored end to end — the
 * same classification `detect` in `./enrich.ts` makes, for the same impersonation reason.
 */
export const splitAuthored = (
	body: string,
	issue: number,
	legacyPreserved: (body: string) => string | null,
): {readonly authored: string; readonly preserved: string} => {
	const match = MARKER_RE.exec(body);
	if (match !== null && Number(match[1]) === issue) {
		return {authored: body.slice(0, match.index), preserved: body.slice(match.index)};
	}
	if (match === null) {
		const legacy = legacyPreserved(body);
		if (legacy !== null && body.endsWith(legacy)) {
			return {authored: body.slice(0, body.length - legacy.length), preserved: legacy};
		}
	}
	return {authored: body, preserved: ""};
};

const CONFORMING_LINE = `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}`;

/** Headings in the authored region whose text is exactly the conforming text, at any level. */
const namedHeadings = (authored: string): ReadonlyArray<Heading> =>
	scanHeadings(authored.split("\n")).filter((heading) => heading.text === HEADING_TEXT);

/** A list item with a plain bullet marker — the shape the conversion rewrites. */
const PLAIN_BULLET = /^([ \t]*[-*+][ \t]+)(.*)$/;

/**
 * A line that opens some block *other* than a plain bullet — an ordered item, a blockquote, a
 * fence, a thematic break. Tested before {@link PLAIN_BULLET}, which would otherwise swallow a
 * spaced thematic break (`- - -`).
 */
const NON_BULLET_BLOCK =
	/^[ \t]*(?:\d{1,9}[.)][ \t]+|>|```|~~~|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

const plainBullet = (line: string): RegExpExecArray | null =>
	isCheckboxItem(line) || NON_BULLET_BLOCK.test(line) ? null : PLAIN_BULLET.exec(line);

type BulletConversion =
	| {
			readonly _tag: "Converted";
			readonly lines: ReadonlyArray<string>;
			readonly converted: NonEmptyReadonlyArray<number>;
	  }
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * Rewrite every plain bullet under `heading` to an unchecked checkbox, or prove the section is not
 * a plain list.
 *
 * **The strict window is the list itself** — the first plain bullet through the last one. Outside
 * it the section is left alone, because an enriched body's authored region ends on the `---` the
 * envelope writes and a preamble sentence under the heading is ordinary prose; refusing on either
 * would refuse nearly every body this repair exists for. Inside it, anything that is not a bullet,
 * a blank line, or an open bullet's lazy continuation is a refusal naming what it read: the reader
 * closes the criterion at each of those, so converting around one would ship a list whose middle
 * holds text no grader ever reads.
 *
 * A checkbox item **anywhere** in the section refuses regardless of the window: the block already
 * states criteria, and promoting the bullets beside them would add to what it says rather than fix
 * how it says it.
 */
const convertBullets = (lines: ReadonlyArray<string>, heading: Heading): BulletConversion => {
	const section = sectionOf(lines, heading);
	const checkbox = section.findIndex(isCheckboxItem);
	if (checkbox !== -1) {
		return {
			_tag: "Refused",
			reason: `line ${heading.line + checkbox + 1} is already a checkbox item ("${section[checkbox]?.trim()}") — promoting the bullets beside it would add criteria to a block that already states some`,
		};
	}
	const bullets = section.flatMap((line, offset) => (plainBullet(line) === null ? [] : [offset]));
	const first = bullets[0];
	const last = bullets.at(-1);
	if (first === undefined || last === undefined) {
		return {_tag: "Refused", reason: "the section under the heading holds no list item to convert"};
	}

	const rewritten = [...lines];
	const converted: number[] = [];
	let open = false;
	for (let offset = first; offset <= last; offset++) {
		const line = section[offset] ?? "";
		const index = heading.line + offset;
		const at = index + 1;
		if (line.trim() === "") {
			open = false;
			continue;
		}
		const bullet = plainBullet(line);
		if (bullet !== null) {
			const marker = bullet[1] ?? "";
			const text = bullet[2] ?? "";
			if (text.trim() === "") {
				return {_tag: "Refused", reason: `line ${at} is a list item carrying no text ("${line}")`};
			}
			rewritten[index] = `${marker}[ ] ${text}`;
			converted.push(at);
			open = true;
			continue;
		}
		if (!open) {
			return {
				_tag: "Refused",
				reason: `line ${at} sits between the list's items and is not one ("${line.trim()}")`,
			};
		}
	}
	const [head, ...rest] = converted;
	if (head === undefined) {
		return {_tag: "Refused", reason: "the section under the heading holds no list item to convert"};
	}
	return {_tag: "Converted", lines: rewritten, converted: [head, ...rest]};
};

/**
 * Plan the repair of one issue body, or the proof that none is safe.
 *
 * Total over the reader's three answers, and **the write is pre-verified**: a `Repaired` plan's
 * body has already been read back through `read` and answered `Found`, so the caller never patches
 * a body the gate would still refuse. Only shape changes — every criterion's text and checked state
 * is byte-for-byte the drifted body's.
 *
 * The two repairs compose in one pass, and the order is what keeps the heading path exactly as it
 * was: the level is rewritten first, and the bullet conversion is reached only when the level fix
 * alone still does not read. A body that already carries checkbox items is therefore never touched
 * below its heading.
 */
export const planRepair = (
	body: string,
	issue: number,
	legacyPreserved: (body: string) => string | null,
): CriteriaRepairPlan => {
	const whole = read(body);
	if (whole._tag === "Found") return {_tag: "AlreadyConforming"};
	if (whole._tag === "Absent") return {_tag: "NoBlock"};

	const {authored, preserved} = splitAuthored(body, issue, legacyPreserved);
	const named = namedHeadings(authored);
	const first = named[0];
	if (first === undefined) {
		return {
			_tag: "Refused",
			reason: `no "${HEADING_TEXT}" heading in the authored region — ${whole.reason} (${whole.evidence})`,
		};
	}
	if (named.length > 1) {
		return {
			_tag: "Refused",
			reason: `the authored region carries ${named.length} "${HEADING_TEXT}" headings — which one is the contract is undecidable`,
		};
	}

	const repairs: CriteriaRepair[] = [];
	let lines: ReadonlyArray<string> = authored.split("\n");
	if (first.level !== HEADING_LEVEL) {
		const levelled = [...lines];
		levelled[first.line - 1] = CONFORMING_LINE;
		lines = levelled;
		repairs.push({_tag: "HeadingLevel", line: first.line, fromLevel: first.level});
	}
	const heading: Heading = {...first, level: HEADING_LEVEL};

	const unreadable = (attempt: ReadonlyArray<string>): string | null => {
		const back = read(`${attempt.join("\n")}${preserved}`);
		if (back._tag === "Found") return null;
		return back._tag === "Malformed"
			? `${back.reason} (${back.evidence})`
			: "the block reads as absent";
	};

	const afterHeading = unreadable(lines);
	if (afterHeading !== null) {
		const conversion = convertBullets(lines, heading);
		if (conversion._tag === "Refused") {
			return {
				_tag: "Refused",
				reason: `a pure shape rewrite does not make the block readable — ${conversion.reason}; the reader answers: ${afterHeading}`,
			};
		}
		lines = conversion.lines;
		repairs.push({_tag: "BulletItems", lines: conversion.converted});
	}

	const repaired = `${lines.join("\n")}${preserved}`;
	const back = read(repaired);
	if (back._tag !== "Found") {
		const remaining =
			back._tag === "Malformed" ? `${back.reason} (${back.evidence})` : "the block reads as absent";
		return {
			_tag: "Refused",
			reason: `a pure shape rewrite does not make the block readable — ${remaining}`,
		};
	}
	const [head, ...rest] = repairs;
	if (head === undefined) {
		// Unreachable by construction: a body that reads back `Found` having been rewritten in no way
		// is the `Found` this function already answered `AlreadyConforming` on.
		return {
			_tag: "Refused",
			reason: `the block reads as ${whole.reason} and no shape defect this verb repairs explains it (${whole.evidence})`,
		};
	}
	return {_tag: "Repaired", body: repaired, repairs: [head, ...rest], criteria: back.value};
};
