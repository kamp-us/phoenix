/**
 * The mechanical acceptance-criteria heading repair — the pure core of `triage repair-criteria`.
 *
 * `wire/acceptance-criteria.ts` pins the one conforming heading (`### Acceptance criteria`, level
 * and spelling both part of it), and the board carries hundreds of already-filed bodies whose block
 * sits at `##` — every one answers `Malformed`, and the review gate may neither hand-parse the block
 * nor invent criteria, so the PR stalls with no verdict at all (#5744; #5565 is the producer-side
 * fix and stops only *new* drift). This module plans the one repair that is safe to automate:
 * rewrite a heading whose text is already exactly the conforming text and whose only defect is the
 * level. Anything else is refused, never guessed — repairing drifted *text* is indistinguishable
 * from inventing a contract.
 *
 * The plan acts on the **authored region only**. The `<!-- fabrika:enriched … -->` marker (or the
 * legacy v1 envelope) is the boundary `triage enrich`'s own guards rely on, and a `##` heading down
 * inside the preserved original is a historical record — rewriting it would falsify the verbatim
 * block. Classification, though, reads the **whole body**, because that is what the reader grades:
 * a body whose only drift lives inside the preserved block is un-gateable *and* unrepairable, and
 * that pair must land on a refusal that says so, not on a plausible no-op.
 */

import {
	type AcceptanceCriterion,
	HEADING_LEVEL,
	HEADING_TEXT,
	type Heading,
	read,
	scanHeadings,
} from "../wire/acceptance-criteria.ts";
import type {NonEmptyReadonlyArray} from "../wire/format.ts";
import {MARKER_RE} from "./enrich.ts";

export type CriteriaRepairPlan =
	/** One drifted heading rewritten; `body` is the whole repaired body, verified through `read`. */
	| {
			readonly _tag: "Repaired";
			readonly body: string;
			/** 1-based line of the heading that was rewritten, in the body as it was. */
			readonly line: number;
			readonly fromLevel: number;
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

/** Headings in the authored region whose text is exact and whose only defect is the level. */
const levelDrifted = (authored: string): ReadonlyArray<Heading> =>
	scanHeadings(authored.split("\n")).filter(
		(heading) => heading.text === HEADING_TEXT && heading.level !== HEADING_LEVEL,
	);

/**
 * Plan the repair of one issue body, or the proof that none is safe.
 *
 * Total over the reader's three answers, and **the write is pre-verified**: a `Repaired` plan's
 * body has already been read back through `read` and answered `Found`, so the caller never patches
 * a body the gate would still refuse. Only the drifted heading line changes — every criterion text
 * and checked state below it is byte-for-byte the drifted body's.
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
	const drifted = levelDrifted(authored);
	const first = drifted[0];
	if (first === undefined) {
		return {
			_tag: "Refused",
			reason: `no level-drifted "${HEADING_TEXT}" heading in the authored region — ${whole.reason} (${whole.evidence})`,
		};
	}
	if (drifted.length > 1) {
		return {
			_tag: "Refused",
			reason: `the authored region carries ${drifted.length} level-drifted "${HEADING_TEXT}" headings — which one is the contract is undecidable`,
		};
	}

	const lines = authored.split("\n");
	lines[first.line - 1] = CONFORMING_LINE;
	const repaired = `${lines.join("\n")}${preserved}`;
	const back = read(repaired);
	if (back._tag !== "Found") {
		const named =
			back._tag === "Malformed" ? `${back.reason} (${back.evidence})` : "the block reads as absent";
		return {
			_tag: "Refused",
			reason: `rewriting the level alone does not make the block readable — ${named}`,
		};
	}
	return {
		_tag: "Repaired",
		body: repaired,
		line: first.line,
		fromLevel: first.level,
		criteria: back.value,
	};
};
