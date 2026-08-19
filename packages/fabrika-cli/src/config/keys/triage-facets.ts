/**
 * `triageFacets` — what each triage facet owns, and every label an input can make it keep.
 *
 * The shipped default is phoenix's own vocabulary, taken straight off `triage/facets.ts` rather than
 * restated here, so a bare repo reconciles exactly as phoenix does today.
 *
 * **The containment invariant is this key's `refuseLoad`, and that seat is the point.** A facet is
 * delete authority: `owns` strips every label it matches that the keep set does not name, which is
 * how #4285 removed an issue's only priority. Checked at a call site, the rule is one a new verb can
 * forget; checked here, every reader of a loaded config inherits it and a violating config is refused
 * before any write path is reachable. The rule itself, and why it refuses in one direction for a
 * pattern and both for a set, is `../containment.ts`.
 *
 * This module ships the key, its default and that refusal. Reading the *values* off it at the
 * reconcile's call sites — so a repo can actually declare its own board vocabulary — is #6294's.
 */

import {FACET_VOCABULARY} from "../../triage/facets.ts";
import {
	containmentRefusal,
	type FacetVocabulary,
	type Ownership,
	patternError,
} from "../containment.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const TRIAGE_FACETS = "triageFacets";

const nonEmptyString = (raw: unknown): string | null =>
	typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;

const labelSet = (raw: unknown): ReadonlyArray<string> | null => {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const labels: string[] = [];
	for (const entry of raw) {
		const label = nonEmptyString(entry);
		if (label === null) return null;
		labels.push(label);
	}
	return labels;
};

/** A facet declares its ownership as `owns` (a pattern) or `ownsLabels` (an explicit set), never both. */
const decodeOwnership = (
	record: Record<string, unknown>,
	where: string,
): Ownership | {readonly reason: string} => {
	const pattern = record.owns;
	const set = record.ownsLabels;
	if (pattern !== undefined && set !== undefined) {
		return {reason: `${where} declares both \`owns\` and \`ownsLabels\` — a facet owns one way`};
	}
	if (pattern !== undefined) {
		const source = nonEmptyString(pattern);
		if (source === null) return {reason: `${where}'s \`owns\` is not a non-empty pattern string`};
		const broken = patternError(source);
		return broken === null
			? {_tag: "Pattern", source}
			: {reason: `${where}'s \`owns\` is not a usable regular expression: ${broken}`};
	}
	if (set !== undefined) {
		const labels = labelSet(set);
		return labels === null
			? {reason: `${where}'s \`ownsLabels\` is not a non-empty array of label strings`}
			: {_tag: "Set", labels};
	}
	return {reason: `${where} declares neither \`owns\` nor \`ownsLabels\``};
};

const decodeFacet = (raw: unknown, index: number): FacetVocabulary | {readonly reason: string} => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {reason: `\`${TRIAGE_FACETS}\`[${index}] is not an object`};
	}
	const record = raw as Record<string, unknown>;
	const name = nonEmptyString(record.name);
	if (name === null) return {reason: `\`${TRIAGE_FACETS}\`[${index}] declares no \`name\``};
	const where = `\`${TRIAGE_FACETS}\` facet \`${name}\``;
	const values = labelSet(record.values);
	if (values === null) {
		return {reason: `${where}'s \`values\` is not a non-empty array of label strings`};
	}
	const ownership = decodeOwnership(record, where);
	return "reason" in ownership ? ownership : {name, owns: ownership, values};
};

const decode = (raw: unknown): Decoded<ReadonlyArray<FacetVocabulary>> => {
	if (!Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${TRIAGE_FACETS}\` is not an array`};
	}
	// An empty table would hand every facet zero delete authority, so a stale label is never cleaned
	// up and `triage apply` silently stops reconciling — the gate disabled by a settings file.
	if (raw.length === 0) {
		return {
			_tag: "Malformed",
			reason: `\`${TRIAGE_FACETS}\` is empty — no facet would own anything`,
		};
	}
	const facets: FacetVocabulary[] = [];
	for (const [index, entry] of raw.entries()) {
		const facet = decodeFacet(entry, index);
		if ("reason" in facet) return {_tag: "Malformed", reason: facet.reason};
		facets.push(facet);
	}
	const duplicate = facets.find((facet, i) => facets.findIndex((f) => f.name === facet.name) !== i);
	return duplicate === undefined
		? {_tag: "Value", value: facets}
		: {
				_tag: "Malformed",
				reason: `\`${TRIAGE_FACETS}\` declares \`${duplicate.name}\` twice — one facet, one row`,
			};
};

export const triageFacetsKey: KeyGroup<ReadonlyArray<FacetVocabulary>> = {
	key: TRIAGE_FACETS,
	shippedDefault: FACET_VOCABULARY,
	decode,
	refuseLoad: (facets) => containmentRefusal(TRIAGE_FACETS, facets),
	jsonSchema: {
		type: "array",
		description:
			"What each triage facet owns and every label an input can make it keep. A facet declares its ownership as `owns` (a regex) or `ownsLabels` (an explicit set), never both.",
		minItems: 1,
		items: {
			type: "object",
			properties: {
				name: {type: "string", minLength: 1, description: "The facet's name."},
				values: {
					type: "array",
					description: "Every label this facet may keep.",
					items: {type: "string", minLength: 1},
					minItems: 1,
				},
				owns: {
					type: "string",
					minLength: 1,
					description:
						"A regular expression matching the labels this facet has delete authority over.",
				},
				ownsLabels: {
					type: "array",
					description: "The explicit set of labels this facet has delete authority over.",
					items: {type: "string", minLength: 1},
					minItems: 1,
				},
			},
			required: ["name", "values"],
			additionalProperties: false,
		},
	},
};
