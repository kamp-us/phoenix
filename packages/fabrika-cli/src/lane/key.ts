/**
 * The lane key — how a lane is addressed, and where that address puts it on disk.
 *
 * Two kinds. An **issue lane** is keyed by the issue number it drives, under `.fabrika/lanes/`. A
 * **chore lane** is keyed by a name, because a recurring chore has no issue number to be keyed by,
 * and lives under `.fabrika/chores/`. Both fold through the same fresh-process fold; the key
 * decides the directory and the boot template, nothing else.
 *
 * The kind travels **in the argument** (`5673` vs `chore:park-sweep`) rather than in a flag beside
 * it, so a key that names one kind while the root names the other cannot be expressed. A chore name
 * is checked against one shape before it ever reaches a path join: it is a directory name, so
 * anything carrying a separator, a traversal, or shell-significant bytes is refused as malformed
 * rather than resolved into a path nobody meant.
 */
import {
	DEFAULT_ARCHIVED_LANES_ROOT,
	DEFAULT_CHORES_ROOT,
	DEFAULT_LANES_ROOT,
	type LaneRef,
} from "./store.ts";

/** What marks an argument as naming a chore rather than an issue. */
export const CHORE_PREFIX = "chore:";

/** Lowercase kebab, the repo's file-name idiom — one shape, so a name reads the same everywhere. */
const CHORE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Long enough for a descriptive chore name, short enough to stay a legible directory. */
export const CHORE_NAME_LIMIT = 64;

export type LaneKey =
	| {readonly _tag: "Issue"; readonly lane: string}
	| {readonly _tag: "Chore"; readonly name: string};

export type KeyResult =
	| {readonly _tag: "Key"; readonly key: LaneKey}
	| {readonly _tag: "Malformed"; readonly raw: string; readonly reason: string};

const malformed = (raw: string, reason: string): KeyResult => ({_tag: "Malformed", raw, reason});

/** Read one `lane` argument as a key. Total: every string is a key or a named refusal. */
export const parseKey = (raw: string): KeyResult => {
	if (!raw.startsWith(CHORE_PREFIX)) {
		return raw === ""
			? malformed(raw, "a lane key is empty")
			: {_tag: "Key", key: {_tag: "Issue", lane: raw}};
	}
	const name = raw.slice(CHORE_PREFIX.length);
	if (name.length > CHORE_NAME_LIMIT) {
		return malformed(raw, `a chore name is at most ${CHORE_NAME_LIMIT} characters`);
	}
	return CHORE_NAME.test(name)
		? {_tag: "Key", key: {_tag: "Chore", name}}
		: malformed(
				raw,
				`a chore name is lowercase kebab (${CHORE_NAME.source}) — it is a directory name, so a separator, a traversal or an empty name is refused`,
			);
};

/** The root a key lives under when the caller relocates nothing. */
export const defaultRoot = (key: LaneKey): string =>
	key._tag === "Chore" ? DEFAULT_CHORES_ROOT : DEFAULT_LANES_ROOT;

/**
 * Where an archived lane goes, for the one kind that can be archived.
 *
 * Only an issue lane: archiving turns on the lane's issue reading closed, and a chore lane drives no
 * issue, so the gate can never hold for one. There is deliberately no chore counterpart
 * to reach for.
 */
export const archivedRoot = (): string => DEFAULT_ARCHIVED_LANES_ROOT;

/** Where a key puts its lane — the caller's `--root` wins over the kind's default. */
export const laneRef = (key: LaneKey, root: string | null): LaneRef => ({
	root: root ?? defaultRoot(key),
	lane: key._tag === "Chore" ? key.name : key.lane,
});

/**
 * The committed template a lane of this kind boots from, by file name under `./templates/`.
 *
 * Keyed on the kind rather than a whole key because `lane migrate` sweeps a *root*, which selects a
 * kind and names no lane — asking it for a key would mean inventing one nobody addressed.
 */
export const templateFile = (kind: LaneKey["_tag"]): string =>
	kind === "Chore" ? "chore.workflow.json" : "coder.workflow.json";

/**
 * A lane key's leading board number, dot-separated from whatever follows it.
 *
 * The separator is required rather than optional: `8012abc` names no issue, and resolving it to
 * 8012 would send a board read at an issue this directory does not drive. The leading digit is
 * non-zero because `#0` is not a board number, so a `0` key names no thread to read or to race on.
 */
const ISSUE_SEGMENT = /^([1-9][0-9]*)(?:\.[^/]+)?$/;

/**
 * What a lane key resolves to on the issue axis.
 *
 * Three answers rather than two, because the two ways of naming no issue are different facts. A
 * chore lane names none *by construction* — it is keyed by a name precisely because no issue exists
 * for it. A key like `frozen-deadlock` names none *by accident*: it is an issue-kind key whose
 * directory name carries no leading board number. A refusal that calls the second one a chore lane
 * sends its reader looking for a `chore:` prefix that is not there.
 */
export type KeyIssue =
	| {readonly _tag: "Issue"; readonly number: number}
	| {readonly _tag: "Chore"}
	| {readonly _tag: "Unnumbered"};

/**
 * The one place the key-to-issue parse lives. Reading a whole directory name as a number yields
 * `NaN` for the quarantine convention `<issue>.frozen-deadlock-<timestamp>`, which every board read
 * then asks about as `#NaN` and refuses UNKNOWN — stranding the seat with no verb able to free it.
 */
export const resolveKeyIssue = (key: LaneKey): KeyIssue => {
	if (key._tag === "Chore") return {_tag: "Chore"};
	const matched = ISSUE_SEGMENT.exec(key.lane);
	return matched?.[1] === undefined
		? {_tag: "Unnumbered"}
		: {_tag: "Issue", number: Number(matched[1])};
};

/** The issue a key drives, or `null`, for a caller the two no-issue arms read the same to. */
export const keyIssue = (key: LaneKey): number | null => {
	const resolved = resolveKeyIssue(key);
	return resolved._tag === "Issue" ? resolved.number : null;
};

/** The same resolution from a raw key, for a sweep reading directory names off a root. */
export const rawKeyIssue = (raw: string): number | null => {
	const parsed = parseKey(raw);
	return parsed._tag === "Key" ? keyIssue(parsed.key) : null;
};
