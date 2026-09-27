/**
 * Whether an already-filed issue can join a plan as a child, and which field lines it still owes.
 *
 * **Adoption appends and never rewrites.** GitHub keeps no issue-body history, so the adopted
 * report, its criteria and every line above them survive byte for byte; what adoption may add is a
 * dated amendment carrying the `**Stories:**` and `**Containment:**` lines the body does not already
 * declare, composed from values the planner supplies — and nothing else. A field the body already
 * declares is never re-declared: the gate refuses a field line that appears twice, so a second line
 * would author the very defect adoption exists to refuse, and a differing value is a rewrite in an
 * append's shape. The readers are the gate's, imported, so an issue this module admits cannot fail
 * the floor on these fields.
 *
 * **An adopted child is parked exactly where a minted one is born.** A triaged issue is pickable, and
 * a plan's child must not be pickable before the gate has checked the plan, so adoption moves it from
 * `status:triaged` to `status:planned` and `plan flip` brings it back on a clean floor. Any other
 * status is refused: the flip only ever restores `status:triaged`, so parking an issue that sat
 * anywhere else would lose where it sat.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8556#issuecomment-5625029977
 */

import {
	type ContainmentVocabulary,
	containmentGap,
	readContainment,
} from "../config/keys/containment-vocabulary.ts";
import {PLANNED, TRIAGED} from "../labels.ts";
import {HELD_LABEL, missingLabelKinds, NEEDS_TRIAGE_LABEL} from "../plan/defects.ts";
import {CONTAINMENT_FIELD, fieldLines, readChildStories, STORIES_FIELD} from "../plan/ledger.ts";
import {EPIC_TYPE_LABEL} from "../triage/facets.ts";
import {read as readAcceptanceCriteria} from "../wire/acceptance-criteria.ts";
import {BAD_SECTIONS, OFF_VOCABULARY} from "./codes.ts";
import type {CycleDoc} from "./run.ts";

/** A planner-supplied `--stories` value, parsed through the gate's grammar before anything is read. */
export type StoriesFlag =
	| {readonly _tag: "Ids"; readonly ids: ReadonlyArray<number>}
	| {readonly _tag: "NonConforming"; readonly value: string};

export const parseStoriesFlag = (value: string): StoriesFlag => {
	const read = readChildStories(value);
	return read._tag === "Ids" ? read : {_tag: "NonConforming", value: value.trim()};
};

const renderStories = (ids: ReadonlyArray<number>): string =>
	ids.length === 0 ? "none" : ids.join(", ");

const sameIds = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
	[...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");

export interface AdoptionInput {
	readonly body: string;
	readonly labels: ReadonlyArray<string>;
	readonly assignees: ReadonlyArray<string>;
	readonly cycleDoc: CycleDoc;
	readonly vocabulary: ContainmentVocabulary;
	readonly stories: {readonly _tag: "Ids"; readonly ids: ReadonlyArray<number>} | null;
	/** The raw `--containment` value; a trailing parenthetical is the planner's and is kept. */
	readonly containment: string | null;
}

/**
 * Whether the adoptee still has to leave `status:triaged` for `status:planned`. An issue caught
 * mid-park carrying both is still `owed`, because it is still pickable.
 */
export type Park = "owed" | "already";

export type Adoption =
	| {
			readonly _tag: "Refused";
			readonly code: typeof BAD_SECTIONS | typeof OFF_VOCABULARY;
			readonly reason: string;
	  }
	| {
			readonly _tag: "Adoptable";
			/** The field lines the amendment carries, in order; empty when the body owes none. */
			readonly fields: ReadonlyArray<string>;
			readonly stories: ReadonlyArray<number>;
			readonly containment: string | null;
			readonly park: Park;
	  };

const refused = (code: typeof BAD_SECTIONS | typeof OFF_VOCABULARY, reason: string): Adoption => ({
	_tag: "Refused",
	code,
	reason,
});

const NEVER_REWRITES =
	"adoption appends and never rewrites, so changing it is a body edit a human or triage makes";

/** The judgment over one issue, from what it carries and what the planner supplied. */
export const judgeAdoption = (input: AdoptionInput): Adoption => {
	if (input.labels.includes(EPIC_TYPE_LABEL)) {
		return refused(OFF_VOCABULARY, "it is a type:epic — an epic is never another epic's child.");
	}
	if (input.labels.includes(NEEDS_TRIAGE_LABEL)) {
		return refused(
			OFF_VOCABULARY,
			`it still carries ${NEEDS_TRIAGE_LABEL} — an untriaged issue is not a plannable child.`,
		);
	}
	const missing = missingLabelKinds(input.labels);
	if (missing.length > 0) {
		return refused(
			OFF_VOCABULARY,
			`it is missing a ${missing.join(", ")} label — adoption never writes labels, so triage it first.`,
		);
	}
	const statuses = input.labels.filter((label) => label.startsWith("status:"));
	const stranger = statuses.find((label) => label !== TRIAGED && label !== PLANNED);
	if (stranger !== undefined) {
		return refused(
			OFF_VOCABULARY,
			`it carries ${stranger} — adoption parks a ${TRIAGED} issue on ${PLANNED} until the gate flips it back, and that flip would lose ${stranger}.`,
		);
	}
	const park: Park = statuses.includes(TRIAGED) ? "owed" : "already";
	if (input.labels.includes(HELD_LABEL) && input.assignees.length === 0) {
		return refused(
			OFF_VOCABULARY,
			`it carries ${HELD_LABEL} with nobody assigned — the gate reds that over the whole epic.`,
		);
	}

	const criteria = readAcceptanceCriteria(input.body);
	if (criteria._tag !== "Found") {
		return refused(
			BAD_SECTIONS,
			`its acceptance criteria read as ${criteria._tag === "Absent" ? "absent" : "malformed"} — adoption cannot author criteria; that is a re-scope, not a plan.`,
		);
	}

	for (const field of [STORIES_FIELD, CONTAINMENT_FIELD]) {
		const count = fieldLines(input.body, field).length;
		if (count > 1) {
			return refused(
				BAD_SECTIONS,
				`it carries **${field}:** ${count} times — the gate refuses a field declared twice, and ${NEVER_REWRITES}.`,
			);
		}
	}

	const fields: string[] = [];

	const declared = readChildStories(fieldLines(input.body, STORIES_FIELD)[0]);
	let stories: ReadonlyArray<number>;
	if (declared._tag === "NonConforming") {
		return refused(
			BAD_SECTIONS,
			`its **Stories:** value does not conform: "${declared.value}" — ${NEVER_REWRITES}.`,
		);
	}
	if (declared._tag === "Ids") {
		if (input.stories !== null && !sameIds(input.stories.ids, declared.ids)) {
			return refused(
				BAD_SECTIONS,
				`it already declares **Stories:** ${renderStories(declared.ids)}, not ${renderStories(input.stories.ids)} — ${NEVER_REWRITES}.`,
			);
		}
		stories = declared.ids;
	} else {
		if (input.stories === null) {
			return refused(
				BAD_SECTIONS,
				"it declares no **Stories:** line — pass --stories with the plan's story ids, or none.",
			);
		}
		stories = input.stories.ids;
		fields.push(`**${STORIES_FIELD}:** ${renderStories(stories)}`);
	}

	if (input.cycleDoc !== "present") {
		return {_tag: "Adoptable", fields, stories, containment: null, park};
	}

	const declaredContainment = fieldLines(input.body, CONTAINMENT_FIELD)[0];
	if (declaredContainment !== undefined) {
		const keyword = readContainment(declaredContainment, input.vocabulary);
		if (
			input.containment !== null &&
			readContainment(input.containment, input.vocabulary) !== keyword
		) {
			return refused(
				BAD_SECTIONS,
				`it already declares **Containment:** "${declaredContainment}", not "${input.containment.trim()}" — ${NEVER_REWRITES}.`,
			);
		}
		const gap = containmentGap(input.vocabulary, input.labels, keyword);
		if (gap !== null) {
			return refused(
				BAD_SECTIONS,
				`it is a ${gap.type} whose **Containment:** "${declaredContainment}" is off ${input.vocabulary.values.join(" or ")} — ${NEVER_REWRITES}.`,
			);
		}
		return {_tag: "Adoptable", fields, stories, containment: keyword, park};
	}

	if (input.containment === null) {
		const gap = containmentGap(input.vocabulary, input.labels, null);
		return gap === null
			? {_tag: "Adoptable", fields, stories, containment: null, park}
			: refused(
					BAD_SECTIONS,
					`it is a ${gap.type} with no **Containment:** line and the cycle doc is present — pass --containment ${input.vocabulary.values.join(" or ")}.`,
				);
	}
	const keyword = readContainment(input.containment, input.vocabulary);
	if (keyword === null || containmentGap(input.vocabulary, input.labels, keyword) !== null) {
		return refused(
			OFF_VOCABULARY,
			`--containment "${input.containment.trim()}" is off the resolved vocabulary for this issue (${input.vocabulary.values.join(", ")}).`,
		);
	}
	fields.push(`**${CONTAINMENT_FIELD}:** ${input.containment.trim()}`);
	return {_tag: "Adoptable", fields, stories, containment: keyword, park};
};

/** The amendment's section: one line naming the plan, then the owed field lines, consecutive. */
export const amendmentSection = (epic: number, fields: ReadonlyArray<string>): string =>
	[`Adopted as a child of #${epic} by \`ledger adopt\`.`, "", ...fields].join("\n");
