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
 * 2. items written as an ordinary list under a block that carries no checkbox at all — plain
 *    bullets (`- `) or ordered items (`1. `), one family per block — each rewritten to an unchecked
 *    checkbox with its text byte-for-byte unchanged (#6001, #5981).
 *
 * Anything else is refused, never guessed — repairing drifted *text* is indistinguishable from
 * inventing a contract, and so is deciding that a prose paragraph beside the list was meant as a
 * criterion. The item conversion is bounded the same way from the other side: a block that already
 * carries one checkbox is left alone, because promoting the remaining items there would *add*
 * criteria to a contract that already says something, and a block mixing the two list families is
 * left alone because which one states the criteria is the author's answer, not this module's.
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
	readSpans,
	scanHeadings,
	sectionOf,
} from "../wire/acceptance-criteria.ts";
import type {NonEmptyReadonlyArray} from "../wire/format.ts";
import {MARKER_RE} from "./enrich.ts";

/** One shape defect this module repaired, with the lines it touched. Line numbers are 1-based. */
export type CriteriaRepair =
	| {readonly _tag: "HeadingLevel"; readonly line: number; readonly fromLevel: number}
	| {
			readonly _tag: "BulletItems";
			readonly lines: NonEmptyReadonlyArray<number>;
			readonly family: ListFamily;
	  };

/** What a repair did, for the verb's diagnostic line. */
export const describeRepair = (repair: CriteriaRepair): string => {
	if (repair._tag === "HeadingLevel") {
		return `line ${repair.line}: level ${repair.fromLevel} → ${HEADING_LEVEL}`;
	}
	const many = repair.lines.length !== 1;
	const kind = repair.family === "bullet" ? "plain bullet" : "ordered item";
	return `line${many ? "s" : ""} ${repair.lines.join(", ")}: ${repair.lines.length} ${kind}${
		many ? "s" : ""
	} → unchecked checkbox${many ? "es" : ""}`;
};

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

/** A list item with a plain bullet marker. */
const PLAIN_BULLET = /^([ \t]*[-*+][ \t]+)(.*)$/;

/** A list item with an ordered marker — `1.` or `1)`. */
const ORDERED_ITEM = /^([ \t]*\d{1,9}[.)][ \t]+)(.*)$/;

/**
 * A line that opens a block no list family owns — a blockquote, a fence, a thematic break. Tested
 * before {@link PLAIN_BULLET}, which would otherwise swallow a spaced thematic break (`- - -`).
 */
const FOREIGN_BLOCK = /^[ \t]*(?:>|```|~~~|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/**
 * Which marker grammar the section's items are written in.
 *
 * The conversion is per-family and never mixed. Both families rewrite to the one checkbox shape the
 * reader recognises (`- [ ] `), so an ordered item loses its number — that is the repair, not a
 * side effect, because `wire/acceptance-criteria.ts`'s `CHECKBOX_ITEM` matches `-`/`*` only and an
 * ordered marker can carry no checkbox at all. A section mixing the two is refused rather than
 * normalised: which grammar the author meant is exactly the guess this module does not make.
 */
export type ListFamily = "bullet" | "ordered";

const familyPattern = (family: ListFamily): RegExp =>
	family === "bullet" ? PLAIN_BULLET : ORDERED_ITEM;

/** This family's item on this line, or `null` — a checkbox and a foreign block are never one. */
const listItem = (line: string, family: ListFamily): RegExpExecArray | null =>
	isCheckboxItem(line) || FOREIGN_BLOCK.test(line) ? null : familyPattern(family).exec(line);

/**
 * A line that opens a block of its own beside `family`'s items — a foreign block, or the *other*
 * family's marker. The reader closes the open criterion at each, so converting around one would
 * ship a list whose middle holds text no grader reads (#6001, review round 1).
 */
const foreignToFamily = (line: string, family: ListFamily): boolean =>
	FOREIGN_BLOCK.test(line) ||
	(!isCheckboxItem(line) && familyPattern(family === "bullet" ? "ordered" : "bullet").test(line));

type BulletConversion =
	| {
			readonly _tag: "Converted";
			readonly lines: ReadonlyArray<string>;
			readonly converted: NonEmptyReadonlyArray<number>;
			readonly family: ListFamily;
	  }
	| {readonly _tag: "Refused"; readonly reason: string};

/**
 * Which family the section's items are written in, or the proof that the question has no one answer.
 *
 * Thematic breaks and checkbox items are excluded before counting, so `- - -` never votes and a
 * section already carrying checkboxes is not classified at all (its caller refuses first).
 */
const familyOf = (section: ReadonlyArray<string>): ListFamily | null | "mixed" => {
	const bullets = section.some((line) => listItem(line, "bullet") !== null);
	const ordered = section.some((line) => listItem(line, "ordered") !== null);
	if (bullets && ordered) return "mixed";
	if (bullets) return "bullet";
	return ordered ? "ordered" : null;
};

/**
 * Rewrite every list item under `heading` to an unchecked checkbox, or prove the section is not one
 * plain list.
 *
 * **The strict window is the list itself** — the first item through the last. Outside it the
 * section is left alone, because an enriched body's authored region ends on the `---` the envelope
 * writes and a preamble sentence under the heading is ordinary prose; refusing on either would
 * refuse nearly every body this repair exists for. Inside it, anything that is not an item of the
 * section's own family, a blank line, or an open item's lazy continuation is a refusal naming what
 * it read: the reader closes the criterion at each of those, so converting around one would ship a
 * list whose middle holds text no grader ever reads. **A line that opens a block of its own is not
 * a continuation** even standing directly under an item with no blank line between them — gating
 * that refusal on the open item made it reachable only after a blank line, so `1. ordered` under
 * `- one` converted and shipped exactly the list this rule exists to refuse (#6001, review round 1).
 * That case is now a `mixed` refusal one step earlier, and the guard stays because the two families
 * can still meet inside the window without either being the section's own.
 *
 * A checkbox item **anywhere** in the section refuses regardless of the window: the block already
 * states criteria, and promoting the items beside them would add to what it says rather than fix
 * how it says it.
 *
 * A **nested** sub-item is converted like any other and becomes its own criterion. That is the
 * reader's own semantics — it flattens an indented checkbox item the same way — so the conversion
 * carries it rather than inventing a nesting rule the grader does not have.
 */
const convertBullets = (lines: ReadonlyArray<string>, heading: Heading): BulletConversion => {
	const section = sectionOf(lines, heading);
	const checkbox = section.findIndex(isCheckboxItem);
	if (checkbox !== -1) {
		return {
			_tag: "Refused",
			reason: `line ${heading.line + checkbox + 1} is already a checkbox item ("${section[checkbox]?.trim()}") — promoting the items beside it would add criteria to a block that already states some`,
		};
	}
	const family = familyOf(section);
	if (family === "mixed") {
		return {
			_tag: "Refused",
			reason:
				"the section mixes plain bullets and ordered items — which grammar states the criteria is undecidable",
		};
	}
	if (family === null) {
		return {_tag: "Refused", reason: "the section under the heading holds no list item to convert"};
	}
	const items = section.flatMap((line, offset) =>
		listItem(line, family) === null ? [] : [offset],
	);
	const first = items[0];
	const last = items.at(-1);
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
		const item = listItem(line, family);
		if (item !== null) {
			const marker = item[1] ?? "";
			const text = item[2] ?? "";
			if (text.trim() === "") {
				return {_tag: "Refused", reason: `line ${at} is a list item carrying no text ("${line}")`};
			}
			// An ordered marker carries no checkbox the reader recognises, so the family's marker is
			// replaced by the one bullet shape `CHECKBOX_ITEM` matches; a bullet keeps its own.
			const indent = /^[ \t]*/.exec(marker)?.[0] ?? "";
			rewritten[index] = family === "bullet" ? `${marker}[ ] ${text}` : `${indent}- [ ] ${text}`;
			converted.push(at);
			open = true;
			continue;
		}
		if (!open || foreignToFamily(line, family)) {
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
	return {_tag: "Converted", lines: rewritten, converted: [head, ...rest], family};
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
	let converted: ReadonlyArray<number> = [];
	if (afterHeading !== null) {
		const conversion = convertBullets(lines, heading);
		if (conversion._tag === "Refused") {
			return {
				_tag: "Refused",
				reason: `a pure shape rewrite does not make the block readable — ${conversion.reason}; the reader answers: ${afterHeading}`,
			};
		}
		lines = conversion.lines;
		converted = conversion.converted;
		repairs.push({_tag: "BulletItems", lines: conversion.converted, family: conversion.family});
	}

	const repaired = `${lines.join("\n")}${preserved}`;
	const back = readSpans(repaired);
	if (back._tag !== "Found") {
		const remaining =
			back._tag === "Malformed" ? `${back.reason} (${back.evidence})` : "the block reads as absent";
		return {
			_tag: "Refused",
			reason: `a pure shape rewrite does not make the block readable — ${remaining}`,
		};
	}

	// The read-back answering `Found` proves the block reads; it does not prove it reads back what
	// the conversion rewrote. A marker this module accepts and the reader does not — `+` today, any
	// future divergence tomorrow — converts, reads `Found` off the surviving items, and PATCHes a
	// contract one criterion shorter than the author wrote (#6001, review round 1). Proving one
	// criterion per converted line, rather than pinning today's marker set, is what makes the whole
	// class unrepresentable.
	const counted = back.value.map((span) => span.firstLine + 1);
	if (converted.length > 0 && counted.join(",") !== converted.join(",")) {
		const dropped = converted.filter((line) => !counted.includes(line));
		return {
			_tag: "Refused",
			reason:
				dropped.length > 0
					? `the conversion rewrote line${dropped.length === 1 ? "" : "s"} ${dropped.join(", ")} and the reader counts no criterion there — ${
							counted.length
						} criteri${counted.length === 1 ? "on" : "a"} read back from ${converted.length} converted line${
							converted.length === 1 ? "" : "s"
						}, so the repair would drop what the block says`
					: `the reader counts criteria at line${counted.length === 1 ? "" : "s"} ${counted.join(", ")}, not at the ${converted.length} line${converted.length === 1 ? "" : "s"} the conversion rewrote (${converted.join(", ")})`,
		};
	}

	const [firstSpan, ...restSpans] = back.value;
	const criteria: NonEmptyReadonlyArray<AcceptanceCriterion> = [
		firstSpan.criterion,
		...restSpans.map((span) => span.criterion),
	];
	const [head, ...rest] = repairs;
	if (head === undefined) {
		// Unreachable by construction: a body that reads back `Found` having been rewritten in no way
		// is the `Found` this function already answered `AlreadyConforming` on.
		return {
			_tag: "Refused",
			reason: `the block reads as ${whole.reason} and no shape defect this verb repairs explains it (${whole.evidence})`,
		};
	}
	return {_tag: "Repaired", body: repaired, repairs: [head, ...rest], criteria};
};

/**
 * The disclosure comment one repaired body carries.
 *
 * An in-place edit of a filed body leaves no trace — GitHub keeps no issue-body history — so the
 * only record that the bytes moved is a comment saying so. The founder blessed the in-place edit on
 * exactly that condition (#5981, ruling of 2026-08-18): one comment per edited issue, naming every
 * repair by line and stating that no criterion's text moved. It is composed here rather than at the
 * verb so the wording is unit-tested beside the plan it describes.
 */
export const disclosureComment = (
	repairs: NonEmptyReadonlyArray<CriteriaRepair>,
	criteria: NonEmptyReadonlyArray<AcceptanceCriterion>,
): string =>
	[
		"`triage repair-criteria` repaired this body's acceptance-criteria block in place.",
		"",
		...repairs.map((repair) => `- ${describeRepair(repair)}`),
		"",
		`The block now reads back ${criteria.length} criteri${criteria.length === 1 ? "on" : "a"} through ` +
			"`packages/fabrika-cli/src/wire/acceptance-criteria.ts`. Only the block's shape moved — every " +
			"criterion's text and checked state is byte-for-byte what this body already carried, and nothing " +
			"outside the block was touched.",
	].join("\n");
