/**
 * The lane key — how a lane is addressed, and where that address puts it on disk.
 *
 * Two kinds. An **issue lane** is keyed by the issue number it drives, under `.fabrika/lanes/`. A
 * **chore lane** is keyed by a name, because a recurring chore has no issue number to be keyed by,
 * and lives under `.fabrika/chores/` (#5840). Both fold through the same fresh-process fold; the key
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
 * issue, so the gate can never hold for one (ADR 0352). There is deliberately no chore counterpart
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
