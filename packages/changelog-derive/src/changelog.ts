/**
 * `@kampus/changelog-derive` core — the pure, IO-free projection that turns a set
 * of shipped-work entries (closed-issue title + triaged `type:*` label, with a
 * merged-PR `(#NNN)` backlink) into a Keep a Changelog release section (ADR 0069,
 * issue #394).
 *
 * The changelog is a *derived* artifact: the source of truth is the pipeline's
 * structured metadata (the `type:*` taxonomy from `skills/gh-issue-intake-formats.md`),
 * not the file's own prose. This module owns the one non-obvious decision the ADR
 * delegated to "the CLI's business": the `type:*` → Keep-a-Changelog category map
 * (`TYPE_CATEGORY`), unit-tested here. An entry with no recognized `type:*` is mapped
 * to the `Uncategorized` category — surfaced, never silently dropped (the ADR's
 * standing-input-contract consequence).
 *
 * Everything here is total over `ChangelogEntry[]`: `groupByType` buckets by category,
 * `renderSection` renders one `## [version] — date` block, `deriveChangelog` is the
 * top-level `entries → markdown`. The `git log`/`gh` IO that selects the range and
 * gathers entries lives in `bin.ts`; this core never touches the network or disk.
 */

/**
 * The Keep a Changelog categories this projection emits, in render order. `Uncategorized`
 * is phoenix's addition for the ADR's "flag, never drop" rule — an entry whose issue
 * carries no recognized `type:*` lands here instead of vanishing.
 */
export const CATEGORY_ORDER = ["Added", "Changed", "Fixed", "Decisions", "Uncategorized"] as const;

export type Category = (typeof CATEGORY_ORDER)[number];

/**
 * The `type:*` → category map. Mirrors the `type:*` taxonomy from
 * `skills/gh-issue-intake-formats.md` (§Pipeline labels) / `skills/triage/SKILL.md`:
 *
 * - `type:feature`       → Added   (a new capability)
 * - `type:bug`           → Fixed   (behavior diverged from intent, now corrected)
 * - `type:chore`         → Changed (no behavior change: refactors, bumps, doc edits)
 * - `type:decision`      → Decisions (a recorded ADR choice)
 * - `type:investigation` → Changed (the diagnosis/cleanup that shipped from it)
 * - `type:epic`          → Changed (umbrella; rarely closed directly, but never dropped)
 *
 * An entry whose `type` is absent or not a key here maps to `Uncategorized`.
 */
export const TYPE_CATEGORY: Readonly<Record<string, Category>> = {
	feature: "Added",
	bug: "Fixed",
	chore: "Changed",
	decision: "Decisions",
	investigation: "Changed",
	epic: "Changed",
};

export interface ChangelogEntry {
	/** The issue number whose closure this entry records (the primary source). */
	readonly issue: number;
	/** The merged-PR number, for the `(#NNN)` backlink. Falls back to the issue when absent. */
	readonly pr?: number | undefined;
	/** The human-readable line — the closed-issue title (preferred) or merged-PR title. */
	readonly title: string;
	/** The bare `type:*` value WITHOUT the `type:` prefix (e.g. `feature`), or undefined. */
	readonly type?: string | undefined;
}

export interface ReleaseMeta {
	/** The release version string, rendered into `## [version]`. */
	readonly version: string;
	/** ISO date (`YYYY-MM-DD`) rendered after the em dash. */
	readonly date: string;
}

/** A category with its rendered entry lines, in render order. */
export interface CategoryGroup {
	readonly category: Category;
	readonly entries: ReadonlyArray<ChangelogEntry>;
}

/** Map one entry's `type:*` (sans prefix) to its Keep-a-Changelog category. */
export const categoryFor = (type: string | undefined): Category => {
	if (type === undefined) return "Uncategorized";
	return TYPE_CATEGORY[type] ?? "Uncategorized";
};

/**
 * Bucket entries by mapped category, in `CATEGORY_ORDER`. Empty categories are omitted.
 * Within a category, entries keep their input order (the caller sorts the range; this
 * core does not reorder beyond grouping).
 */
export const groupByType = (
	entries: ReadonlyArray<ChangelogEntry>,
): ReadonlyArray<CategoryGroup> => {
	const buckets = new Map<Category, ChangelogEntry[]>();
	for (const entry of entries) {
		const category = categoryFor(entry.type);
		const bucket = buckets.get(category);
		if (bucket) bucket.push(entry);
		else buckets.set(category, [entry]);
	}
	return CATEGORY_ORDER.flatMap((category) => {
		const bucket = buckets.get(category);
		return bucket && bucket.length > 0 ? [{category, entries: bucket}] : [];
	});
};

/** The `(#NNN)` backlink — the merged PR when known, else the issue. */
const backlink = (entry: ChangelogEntry): string => `(#${entry.pr ?? entry.issue})`;

const renderEntry = (entry: ChangelogEntry): string => `- ${entry.title} ${backlink(entry)}`;

/**
 * Render one Keep-a-Changelog release section: a `## [version] — date` heading, then
 * one `### Category` block per non-empty category with its entry lines. A release with
 * no entries still emits a heading plus a "no entries" note (an empty range is a fact,
 * not an error).
 */
export const renderSection = (
	meta: ReleaseMeta,
	entries: ReadonlyArray<ChangelogEntry>,
): string => {
	const groups = groupByType(entries);
	const head = `## [${meta.version}] — ${meta.date}`;
	if (groups.length === 0) {
		return `${head}\n\n_No closed issues in this range._`;
	}
	const blocks = groups.map((group) => {
		const lines = group.entries.map(renderEntry).join("\n");
		return `### ${group.category}\n\n${lines}`;
	});
	return `${head}\n\n${blocks.join("\n\n")}`;
};

const KAC_HEADER = `# Changelog

All notable changes to this project are documented in this file.

This file is **generated** — its source of truth is the pipeline's closed-issue and
merged-PR metadata (the \`type:*\` taxonomy), derived by \`packages/changelog-derive\`
per [ADR 0069](.decisions/0069-derived-changelog-from-shipped-work.md). Regenerate it;
do not hand-edit it. The format follows [Keep a Changelog](https://keepachangelog.com).`;

/**
 * The top-level projection: render a full `CHANGELOG.md` body — the Keep a Changelog
 * header plus each release section, newest first. Passing one release yields one section
 * (the per-release-batch cadence the ADR fixes).
 */
export const deriveChangelog = (
	releases: ReadonlyArray<{
		readonly meta: ReleaseMeta;
		readonly entries: ReadonlyArray<ChangelogEntry>;
	}>,
): string => {
	const sections = releases.map(({meta, entries}) => renderSection(meta, entries));
	return `${KAC_HEADER}\n\n${sections.join("\n\n")}\n`;
};
