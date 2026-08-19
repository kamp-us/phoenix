/**
 * `boardVocabulary` — the statuses, types, priorities, audiences and standing lanes a repo's board
 * runs on.
 *
 * The shipped default is phoenix's own vocabulary, taken off `labels.ts` and `triage/facets.ts`
 * rather than restated here, so a repo with no `.fabrika.jsonc` reconciles and bootstraps exactly as
 * phoenix does today.
 *
 * **Every sub-key is independently optional, and an explicitly-empty one is refused.** A repo that
 * renames only its lanes declares only `standingLanes`; the other four fall to their defaults like
 * any undeclared key. But `"types": []` would leave `triage apply --type` with nothing to accept and
 * `status bootstrap` with nothing to create — a gate turned off by a settings file, which is the one
 * thing this surface refuses whole.
 *
 * **A sub-key this module does not know is refused too.** `"standingLane": [...]` would otherwise be
 * a declaration the operator believes is configured and is not.
 *
 * The values decoded here are what each facet may keep; the *delete authority* over them is
 * `../board.ts`'s composition, and the containment invariant between the two is checked there —
 * `triageFacets` still carries its own load-time refusal over what a repo declares directly.
 */

import {DEFAULT_BOARD_VOCABULARY} from "../../triage/facets.ts";
import {type BoardVocabulary, type StatusNames, statusList} from "../board.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";

export const BOARD_VOCABULARY = "boardVocabulary";

const STATUS_ROLES = ["needsTriage", "triaged", "needsInfo", "planned", "awaitingRelease"] as const;
const LIST_KEYS = ["types", "priorities", "audiences", "standingLanes"] as const;

type ListKey = (typeof LIST_KEYS)[number];

interface Bad {
	readonly reason: string;
}

const isBad = (value: unknown): value is Bad =>
	typeof value === "object" && value !== null && "reason" in value;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const named = (path: string): string => `\`${BOARD_VOCABULARY}\`'s \`${path}\``;

const decodeList = (raw: unknown, key: ListKey): ReadonlyArray<string> | Bad => {
	if (!Array.isArray(raw)) return {reason: `${named(key)} is not an array`};
	const values: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return {reason: `${named(key)} holds an entry that is not a non-empty string`};
		}
		values.push(entry.trim());
	}
	if (values.length === 0) {
		return {reason: `${named(key)} is empty — a facet with no vocabulary accepts nothing`};
	}
	const duplicate = values.find((value, i) => values.indexOf(value) !== i);
	return duplicate === undefined ? values : {reason: `${named(key)} names ${duplicate} twice`};
};

const decodeStatuses = (raw: unknown, shipped: StatusNames): StatusNames | Bad => {
	const record = asRecord(raw);
	if (record === null) return {reason: `${named("statuses")} is not an object of role → label`};
	const roles: ReadonlyArray<string> = STATUS_ROLES;
	const stray = Object.keys(record).find((key) => !roles.includes(key));
	if (stray !== undefined) {
		return {
			reason: `${named(`statuses.${stray}`)} is not a status role — one of ${roles.join(", ")}`,
		};
	}
	const role = (name: (typeof STATUS_ROLES)[number], fallback: string): string | Bad => {
		const value = record[name];
		if (value === undefined) return fallback;
		return typeof value === "string" && value.trim() !== ""
			? value.trim()
			: {reason: `${named(`statuses.${name}`)} is not a non-empty label string`};
	};
	const needsTriage = role("needsTriage", shipped.needsTriage);
	if (isBad(needsTriage)) return needsTriage;
	const triaged = role("triaged", shipped.triaged);
	if (isBad(triaged)) return triaged;
	const needsInfo = role("needsInfo", shipped.needsInfo);
	if (isBad(needsInfo)) return needsInfo;
	const planned = role("planned", shipped.planned);
	if (isBad(planned)) return planned;
	const awaitingRelease = role("awaitingRelease", shipped.awaitingRelease);
	if (isBad(awaitingRelease)) return awaitingRelease;

	const statuses: StatusNames = {needsTriage, triaged, needsInfo, planned, awaitingRelease};
	const labels = statusList(statuses);
	const duplicate = labels.find((label, i) => labels.indexOf(label) !== i);
	return duplicate === undefined
		? statuses
		: {
				reason: `${named("statuses")} gives ${duplicate} to two roles — one status, one role, or the reconcile cannot say which it wrote`,
			};
};

const decode = (raw: unknown): Decoded<BoardVocabulary> => {
	const record = asRecord(raw);
	if (record === null) {
		return {_tag: "Malformed", reason: `\`${BOARD_VOCABULARY}\` is not an object`};
	}
	const known: ReadonlyArray<string> = ["statuses", ...LIST_KEYS];
	const stray = Object.keys(record).find((key) => !known.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not a board vocabulary — one of ${known.join(", ")}`,
		};
	}

	const statuses =
		record.statuses === undefined
			? DEFAULT_BOARD_VOCABULARY.statuses
			: decodeStatuses(record.statuses, DEFAULT_BOARD_VOCABULARY.statuses);
	if (isBad(statuses)) return {_tag: "Malformed", reason: statuses.reason};

	const list = (key: ListKey, fallback: ReadonlyArray<string>): ReadonlyArray<string> | Bad =>
		record[key] === undefined ? fallback : decodeList(record[key], key);

	const types = list("types", DEFAULT_BOARD_VOCABULARY.types);
	if (isBad(types)) return {_tag: "Malformed", reason: types.reason};
	const priorities = list("priorities", DEFAULT_BOARD_VOCABULARY.priorities);
	if (isBad(priorities)) return {_tag: "Malformed", reason: priorities.reason};
	const audiences = list("audiences", DEFAULT_BOARD_VOCABULARY.audiences);
	if (isBad(audiences)) return {_tag: "Malformed", reason: audiences.reason};
	const standingLanes = list("standingLanes", DEFAULT_BOARD_VOCABULARY.standingLanes);
	if (isBad(standingLanes)) return {_tag: "Malformed", reason: standingLanes.reason};

	return {_tag: "Value", value: {statuses, types, priorities, audiences, standingLanes}};
};

export const boardVocabularyKey: KeyGroup<BoardVocabulary> = {
	key: BOARD_VOCABULARY,
	shippedDefault: DEFAULT_BOARD_VOCABULARY,
	decode,
};
