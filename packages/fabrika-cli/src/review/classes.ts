/**
 * The artifact-class partition of a PR's changed files, and the flags derived beside it — `self` and
 * `harness` on the review partition, `governance` on the ship one.
 *
 * The map is a **fixed path partition** so two runs cannot disagree, and it is **total**: a file the
 * map cannot place is `code`, never dropped. An unclassified file silently excluded from every
 * rubric is a review that never saw it (#4060).
 */

import {SHIPPED_GOVERNED_ROOTS} from "../config/keys/governed-roots.ts";
import {SHIPPED_DECISIONS_DIR} from "../config/keys/paths.ts";

export {SHIPPED_GOVERNED_ROOTS};

/** The three artifact classes, in the fixed order the line grammar prints them. */
export const CLASS_NAMES = ["code", "doc", "skill"] as const;
export type ClassName = (typeof CLASS_NAMES)[number];

/** The namespace a present class derives. `review post` refuses any namespace outside this image. */
export const namespaceOf = (name: ClassName): string => `review-${name}`;

/** True when the path is `SKILL.md` itself, wherever it sits. */
const isSkillFile = (path: string): boolean => path === "SKILL.md" || path.endsWith("/SKILL.md");

/**
 * The class one path belongs to.
 *
 * The last two `skill` rows — `skills/**` and any `SKILL.md` anywhere — are what keep the map honest
 * on a repo that homes its skills elsewhere; without them a foreign repo's
 * `skills/deploy-notes/SKILL.md` partitions to `doc` and is graded by the wrong rubric.
 */
export const classOf = (path: string): ClassName => {
	if (
		path.startsWith("claude-plugins/") ||
		path.startsWith(".claude/") ||
		path.startsWith("skills/") ||
		isSkillFile(path)
	) {
		return "skill";
	}
	return path.endsWith(".md") ? "doc" : "code";
};

/** The `self` flag: this diff edits the `review` skill's own text (ADR 0052's BASE-revision fence). */
const SELF_ROOT = "claude-plugins/fabrika/skills/review/";

/**
 * The `harness` flag's closed three-root list — *this* repo's governance surface.
 *
 * The class map's two portability rows deliberately do not set it: they classify a foreign repo's
 * skill text for the rubric, while `harness` marks this harness. What governance does with the flag
 * is the `governance` skill's decision; the flag only makes the seam mechanical.
 */
const HARNESS_ROOTS = [".claude/", ".github/", "claude-plugins/"];

export interface ClassTally {
	readonly name: ClassName;
	readonly files: number;
}

export interface Partition {
	/** Only the classes actually present, in {@link CLASS_NAMES} order. */
	readonly classes: ReadonlyArray<ClassTally>;
	readonly self: boolean;
	readonly harness: boolean;
	readonly scanned: number;
}

export const partition = (files: ReadonlyArray<string>): Partition => {
	const counts = new Map<ClassName, number>();
	for (const file of files) {
		const name = classOf(file);
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return {
		classes: CLASS_NAMES.filter((name) => (counts.get(name) ?? 0) > 0).map((name) => ({
			name,
			files: counts.get(name) ?? 0,
		})),
		self: files.some((file) => file.startsWith(SELF_ROOT)),
		harness: files.some((file) => HARNESS_ROOTS.some((root) => file.startsWith(root))),
		scanned: files.length,
	};
};

/**
 * The namespaces `review post` may emit — narrower than what a PR *requires*, and deliberately so.
 * The required set is {@link shipNamespacesOf}'s; this is the image the emit fence checks against.
 */
export const namespacesOf = (result: Partition): ReadonlyArray<string> =>
	result.classes.map((entry) => namespaceOf(entry.name));

/**
 * The `ui` class, which extends the three above.
 *
 * It lives here rather than in a second copy under `ship/` so the two groups partition one map: v1
 * printed the class set from one derivation and hand-copied it into another, and the copy dropped a
 * class on a live PR (#4730). Both `review scope` and `ship scope` print these rows, in this order.
 *
 * `review scope` printing `ui` is not `review` growing a rendered rubric. It still emits no
 * `review-ui` verdict — {@link namespacesOf} over {@link CLASS_NAMES} is the narrower image
 * `review post` fences on, and that fence is untouched. What the two verbs must agree on is what a
 * file is *and* what the merge gate will require: while only the ship side derived `ui`, a reviewer
 * read its own short set as the whole bar, PASSed, and the gate then refused on a namespace nobody
 * had been told to route (#6664).
 */
export const SHIP_CLASS_NAMES = [...CLASS_NAMES, "ui"] as const;
export type ShipClassName = (typeof SHIP_CLASS_NAMES)[number];

/** A rendered frontend surface. Its own tests are code, not UI — they render nothing. */
export const isUiSurface = (path: string): boolean =>
	path.startsWith("apps/web/src/") && !/\.(?:test|spec)\.tsx?$/.test(path);

/**
 * The decision corpus's root as this package ships it, trailing slash included so it matches as a
 * path prefix.
 *
 * Where the corpus actually lives is `decisionsDir` in `.fabrika.jsonc`
 * (`../config/keys/paths.ts`). This is the shipped value, re-exported from that one home so a
 * prefix reader with no config load in reach still reads one list instead of a second literal.
 */
export const DECISIONS_ROOT = `${SHIPPED_DECISIONS_DIR}/`;

/**
 * The whole `governance` requirement: at least one changed path under at least one governed root.
 *
 * `roots` is a parameter with no default, and that is the point. The set is `governedRoots` in
 * `.fabrika.jsonc` (`../config/keys/governed-roots.ts`); a default here would let a caller derive
 * the namespace over phoenix's roots inside a repo that declared its own — one question with two
 * answers, which is what #4730 closed. A caller with no config load in reach passes
 * {@link SHIPPED_GOVERNED_ROOTS} and is visibly doing so.
 */
export const touchesGovernanceRoot = (
	files: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
): boolean => files.some((file) => roots.some((root) => file.startsWith(root)));

export interface ShipPartition {
	/** Only the classes actually present, in {@link SHIP_CLASS_NAMES} order. */
	readonly classes: ReadonlyArray<{readonly name: ShipClassName; readonly files: number}>;
	/** {@link touchesGovernanceRoot} over the same file list — a flag, not a class. */
	readonly governance: boolean;
	readonly scanned: number;
}

export const partitionWithUi = (
	files: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
): ShipPartition => {
	const base = partition(files);
	const ui = files.filter(isUiSurface).length;
	return {
		classes: ui === 0 ? base.classes : [...base.classes, {name: "ui" as const, files: ui}],
		governance: touchesGovernanceRoot(files, roots),
		scanned: base.scanned,
	};
};

/**
 * The namespaces one PR's diff requires.
 *
 * `governance` is appended off the flag rather than mapped off a class because no file class derives
 * it — a governance-bearing path is already partitioned as `skill` or `doc` or `code`, and the
 * namespace is a second, orthogonal question about the same file. Appending is the only direction
 * this function may move a PR's bar: the `review-*` rows are untouched, so a diff under no
 * governance root requires exactly what it required before (#5199).
 */
export const shipNamespacesOf = (result: ShipPartition): ReadonlyArray<string> => {
	const classes = result.classes.map((entry) => `review-${entry.name}`);
	return result.governance ? [...classes, "governance"] : classes;
};

/**
 * The namespaces a derived set carries that the text-review gate hands to another modality instead
 * of emitting.
 *
 * `review-ui` is the whole list, and `governance` is deliberately not on it: a `governance:
 * required` round fires inside the review run and no terminal ends that run with the namespace
 * un-fired (ADR 0293). Routing is the *other* shape — a subject `review` cannot judge at all, whose
 * verdict only the `review-ui` group's own verbs may post.
 *
 * It reads a namespace list rather than a partition so both sides of one lane ask it the same
 * question: `review scope` prints the row a reviewer routes on, and `lane prove` subtracts it from
 * what a `PASS` out of the plain `review` cell has to stand on (#6664).
 */
export const ROUTED_NAMESPACES: ReadonlyArray<string> = ["review-ui"];

export const routedNamespacesOf = (namespaces: ReadonlyArray<string>): ReadonlyArray<string> =>
	namespaces.filter((name) => ROUTED_NAMESPACES.includes(name));

/**
 * The closed namespace vocabulary `ship gate --require` admits.
 *
 * Wider than the review classes, and additively so: `governance` is a namespace no file class
 * derives, but a namespace `ship gate` cannot require is one that only fires when a session
 * remembers to fire it (#5199).
 */
export const SHIP_NAMESPACES: ReadonlyArray<string> = [
	...SHIP_CLASS_NAMES.map((n) => `review-${n}`),
	"governance",
];

/**
 * The linked issue, from the PR body's first closing keyword.
 *
 * Every inflection of the three keywords is admitted — GitHub auto-closes on all of them, and a body
 * that says `Fixed #4287` links exactly as hard as one that says `Fixes #4287`. What an issueless PR
 * *means* is the skill's decision; this only reports it.
 */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[ \t]*:?[ \t]*#(\d+)/i;

export const linkedIssueOf = (body: string): number | null => {
	const matched = CLOSING_KEYWORD.exec(body);
	return matched?.[1] === undefined ? null : Number.parseInt(matched[1], 10);
};

/**
 * The **whole** reference a PR body can carry to its issue: a closing keyword, else the explicit
 * non-closing `Part of #N`, else nothing.
 *
 * It sits here, beside the primitive it wraps, because `ship scope` and `review scope` ask one
 * question of one body. While the `Part of` half lived only under `ship/`, a partial-split PR — the
 * shape `build --partial` emits by contract — was linked to the shipper and issueless to the gate,
 * so the gate's acceptance-criteria step had no issue to grade against (#5446).
 *
 * {@link linkedIssueOf} stays closing-keyword-only. The two kinds are told apart here rather than
 * collapsed into it, because only the closing kind auto-closes on merge.
 */
const PART_OF = /\bpart of\b[ \t]*:?[ \t]*#(\d+)/i;

export interface IssueRef {
	readonly kind: "fixes" | "part-of" | "none";
	readonly number: number | null;
}

export const issueRefOf = (body: string): IssueRef => {
	const closing = linkedIssueOf(body);
	if (closing !== null) return {kind: "fixes", number: closing};
	const part = PART_OF.exec(body);
	return part?.[1] === undefined
		? {kind: "none", number: null}
		: {kind: "part-of", number: Number.parseInt(part[1], 10)};
};

/** `fixes:<n>` / `part-of:<n>`, or the calling group's null token. */
export const renderIssueRef = (ref: IssueRef, nullToken: string): string =>
	ref.number === null ? nullToken : `${ref.kind}:${ref.number}`;
