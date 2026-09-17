/**
 * The lane key — how a lane is addressed, and where that address puts it on disk.
 *
 * Two kinds. An **issue lane** is keyed by the issue number it drives, under `.fabrika/lanes/`. A
 * **chore lane** is keyed by a name, because a recurring chore has no issue number to be keyed by,
 * and lives under `.fabrika/chores/`. Both fold through the same fresh-process fold; the key
 * decides the directory and the boot template, nothing else.
 *
 * The kind travels **in the argument** (`5673` vs `chore:park-sweep`) rather than in a flag beside
 * it, so a key that names one kind while the root names the other cannot be expressed. Both kinds
 * are checked against one shape before either reaches a path join: a key is a directory name, so
 * anything carrying a separator, a traversal, or shell-significant bytes is refused as malformed
 * rather than resolved into a path nobody meant.
 *
 * **Reading a key is also the one place it is canonicalized**, which is what keeps the board, the
 * claim and the directory naming one lane. `05673` and `5673` are one issue to GitHub and were two
 * lanes here: they named different directories, and only the unpadded spelling carried a claim
 * target, so a driver could hold one identity while another drove the other. A padded leading
 * number is trimmed here, once, so every consumer downstream reads the same leaf — there is no
 * second reader left to disagree.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8853
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

/**
 * An issue lane's directory leaf, already canonical.
 *
 * The brand is the invariant: only {@link parseKey} mints one, so a consumer cannot hand-build an
 * `Issue` key out of a raw string and skip the canonicalization every other consumer applied. A
 * caller holding a raw name — a sweep reading directory entries off a root — goes through
 * {@link resolveRawIssue} instead, which parses it like any other key.
 */
declare const CANONICAL: unique symbol;
export type CanonicalLeaf = string & {readonly [CANONICAL]: true};

export type LaneKey =
	| {readonly _tag: "Issue"; readonly lane: CanonicalLeaf}
	| {readonly _tag: "Chore"; readonly name: string};

export type KeyResult =
	| {readonly _tag: "Key"; readonly key: LaneKey}
	| {readonly _tag: "Malformed"; readonly raw: string; readonly reason: string};

const malformed = (raw: string, reason: string): KeyResult => ({_tag: "Malformed", raw, reason});

/**
 * What an issue key may spell: one directory leaf, opening on an alphanumeric.
 *
 * A separator, a traversal, a leading dot or a shell-significant byte is refused rather than joined
 * beneath a root — `../chores/park-sweep` parsed as an issue key and resolved into the chore lanes
 * directory, which is a lane addressing another kind's ledger.
 */
const ISSUE_LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The leading run of digits, when the whole leading segment is one. */
const PADDED = /^0+(?=[0-9])/;

/**
 * Trim a padded leading number, leaving every other leaf byte-identical.
 *
 * Only the segment before the first dot is a number to canonicalize: the rest is the quarantine
 * convention's suffix (`<issue>.frozen-deadlock-<stamp>`), which is a name and not a number. A leaf
 * whose leading segment is not all digits — `epic-5492`, `frozen-deadlock` — is its own canonical
 * form, so a local lane keeps the identity it was opened under.
 */
const canonicalLeaf = (leaf: string): CanonicalLeaf => {
	const dot = leaf.indexOf(".");
	const head = dot === -1 ? leaf : leaf.slice(0, dot);
	if (!/^[0-9]+$/.test(head)) return leaf as CanonicalLeaf;
	const trimmed = head.replace(PADDED, "");
	return (dot === -1 ? trimmed : trimmed + leaf.slice(dot)) as CanonicalLeaf;
};

/** Read one `lane` argument as a key. Total: every string is a key or a named refusal. */
export const parseKey = (raw: string): KeyResult => {
	if (!raw.startsWith(CHORE_PREFIX)) {
		if (raw === "") return malformed(raw, "a lane key is empty");
		return ISSUE_LEAF.test(raw)
			? {_tag: "Key", key: {_tag: "Issue", lane: canonicalLeaf(raw)}}
			: malformed(
					raw,
					`an issue key is one directory leaf (${ISSUE_LEAF.source}) — a separator, a traversal or a leading dot is refused before any path is joined`,
				);
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
 * non-zero because `#0` is not a board number, so a `0` key names no thread to read or to race on —
 * and a padded spelling never reaches here, because {@link parseKey} trimmed it already.
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

/**
 * The same resolution from a raw name, for a sweep reading directory entries off a root.
 *
 * It parses rather than casting, so a swept directory is judged by the one admission every
 * addressed key goes through: a padded leaf reads as the issue it drives, and a name no key could
 * spell is `Unnumbered` — the sweep's own "names no issue" row — instead of a board read at a
 * number nobody addressed.
 */
export const resolveRawIssue = (raw: string): KeyIssue => {
	const parsed = parseKey(raw);
	return parsed._tag === "Key" ? resolveKeyIssue(parsed.key) : {_tag: "Unnumbered"};
};

/** The same resolution from a raw key, for a caller the two no-issue arms read the same to. */
export const rawKeyIssue = (raw: string): number | null => {
	const resolved = resolveRawIssue(raw);
	return resolved._tag === "Issue" ? resolved.number : null;
};
