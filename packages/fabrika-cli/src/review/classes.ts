/**
 * The artifact-class partition of a PR's changed files, and the two flags derived beside it.
 *
 * The map is a **fixed path partition** so two runs cannot disagree, and it is **total**: a file the
 * map cannot place is `code`, never dropped. An unclassified file silently excluded from every
 * rubric is a review that never saw it (#4060).
 */

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

export const namespacesOf = (result: Partition): ReadonlyArray<string> =>
	result.classes.map((entry) => namespaceOf(entry.name));

/**
 * The `ui` class, which `ship scope` derives **in addition to** the three above.
 *
 * It lives here rather than in a second copy under `ship/` so the two groups partition one map: v1
 * printed the class set from one derivation and hand-copied it into another, and the copy dropped a
 * class on a live PR (#4730). `review scope` does not print it — its rubric has no `ui` row — but
 * the rows and their order are shared, which is the property that keeps ship and review from
 * disagreeing about what a file is.
 */
export const SHIP_CLASS_NAMES = [...CLASS_NAMES, "ui"] as const;
export type ShipClassName = (typeof SHIP_CLASS_NAMES)[number];

/** A rendered frontend surface. Its own tests are code, not UI — they render nothing. */
export const isUiSurface = (path: string): boolean =>
	path.startsWith("apps/web/src/") && !/\.(?:test|spec)\.tsx?$/.test(path);

export interface ShipPartition {
	/** Only the classes actually present, in {@link SHIP_CLASS_NAMES} order. */
	readonly classes: ReadonlyArray<{readonly name: ShipClassName; readonly files: number}>;
	readonly scanned: number;
}

export const partitionWithUi = (files: ReadonlyArray<string>): ShipPartition => {
	const base = partition(files);
	const ui = files.filter(isUiSurface).length;
	return {
		classes: ui === 0 ? base.classes : [...base.classes, {name: "ui" as const, files: ui}],
		scanned: base.scanned,
	};
};

export const shipNamespacesOf = (result: ShipPartition): ReadonlyArray<string> =>
	result.classes.map((entry) => `review-${entry.name}`);

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
