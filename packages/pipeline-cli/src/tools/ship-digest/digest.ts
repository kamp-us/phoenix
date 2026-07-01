/**
 * `ship-digest` core — the pure, IO-free founder-facing projection of merged-since work
 * (issue #1595, stories 1/2/7).
 *
 * Where `changelog-derive` renders a *builder's* Keep-a-Changelog (`## [version]` release
 * sections keyed on `type:*`), this renders a *founder's* ship digest for a `--since`
 * window: what shipped, grouped so a non-builder reader can scan it. The top-level split is
 * **product vs infra** (does this touch a kamp.us user surface, or the pipeline/infra
 * substrate?), then by **milestone** (the strategic campaign — `Uncategorized` when none),
 * then by **`type:*`**. This is deliberately NOT the version-heading shape of
 * `changelog-derive`; do not overload that contract.
 *
 * Everything here is total over `ShipEntry[]`. An entry with no milestone / area / type is
 * never dropped — a missing area lands under `Infra` only when it *declares* infra, else it
 * is surfaced under the product tree's `Uncategorized` milestone / `Uncategorized` type, per
 * the "flag, never drop" rule the changelog core also honors. The git-log/`gh` gather that
 * builds the entries JSON is the `/what-shipped` skill's job; this core never touches IO.
 */

/**
 * The top-level split of a founder digest. `Product` = a kamp.us user-facing surface;
 * `Infra` = the pipeline / infra / platform substrate. An entry's `area` selects the
 * section; an absent or unrecognized `area` defaults to `Product` (the reader's default
 * frame is the product) and is surfaced there, never dropped.
 */
export const SECTION_ORDER = ["Product", "Infra"] as const;

export type Section = (typeof SECTION_ORDER)[number];

/**
 * The `type:*` render order within a milestone group. Mirrors the `type:*` taxonomy from
 * `skills/gh-issue-intake-formats.md`. An entry whose `type` is absent or not listed here
 * renders under the trailing `Uncategorized` type bucket — flagged, never dropped.
 */
export const TYPE_ORDER = [
	"feature",
	"bug",
	"chore",
	"decision",
	"investigation",
	"epic",
	"Uncategorized",
] as const;

/** The label rendered for a bare `type:*` value (or the Uncategorized fallback). */
const TYPE_LABEL: Readonly<Record<string, string>> = {
	feature: "Features",
	bug: "Fixes",
	chore: "Chores",
	decision: "Decisions",
	investigation: "Investigations",
	epic: "Epics",
	Uncategorized: "Uncategorized",
};

/** The fallback bucket name shared by the milestone and type axes for a missing key. */
export const UNCATEGORIZED = "Uncategorized";

export interface ShipEntry {
	/** The closed issue number, when the merged work traces to one. */
	readonly issue?: number | undefined;
	/** The merged-PR number — the primary `(#NNN)` backlink; always present. */
	readonly pr: number;
	/** The human-readable line — the closed-issue title (preferred) or merged-PR title. */
	readonly title: string;
	/** The bare `type:*` value WITHOUT the `type:` prefix (e.g. `feature`), or undefined. */
	readonly type?: string | undefined;
	/** The strategic milestone title this work shipped under, or undefined. */
	readonly milestone?: string | undefined;
	/**
	 * The PR's own product/infra signal — `product` or `infra`, set join-free from the merged
	 * PR's `area:*` label (the convention in `gh-issue-intake-formats.md`). The PREFERRED
	 * source; absent/unknown ⇒ consult `joinedArea`, then default Product.
	 */
	readonly area?: string | undefined;
	/**
	 * The area recovered by the gather's PR→issue→milestone join — the FALLBACK signal, used
	 * only when the PR carries no direct `area:*` label. Prefer `area` (join-free) over this;
	 * absent here too ⇒ default Product. See `resolveSection`.
	 */
	readonly joinedArea?: string | undefined;
}

/** The `--since` window the digest reports over, rendered into the heading. */
export interface DigestWindow {
	/** ISO date (`YYYY-MM-DD`) — the `--since` lower bound. */
	readonly since: string;
	/** ISO date (`YYYY-MM-DD`) — the upper bound (typically today). */
	readonly until: string;
}

/** Map a raw area string to its top-level section; absent/unrecognized ⇒ Product. */
export const sectionFor = (area: string | undefined): Section => {
	if (area === undefined) return "Product";
	const normalized = area.trim().toLowerCase();
	return normalized === "infra" ? "Infra" : "Product";
};

/**
 * Resolve an entry's top-level section with the PR-signal-preferred precedence of the
 * `area:*` PR-label convention (issue #1598, documented in `gh-issue-intake-formats.md`):
 * the PR's own product/infra signal (`entry.area`, set join-free from the merged PR's
 * `area:*` label) wins; when it is absent the gather's PR→issue→milestone join fallback
 * (`entry.joinedArea`) is consulted; when neither is present the digest defaults to
 * `Product`. A present-but-blank signal is treated as absent (trimmed); each usable signal
 * is classified through `sectionFor`. This is where "prefer the PR signal, fall back to the
 * join" lives — the join-free readout and its graceful degradation to child #1595's behavior.
 */
export const resolveSection = (entry: ShipEntry): Section => {
	const pr = entry.area?.trim();
	if (pr !== undefined && pr !== "") return sectionFor(pr);
	const joined = entry.joinedArea?.trim();
	if (joined !== undefined && joined !== "") return sectionFor(joined);
	return "Product";
};

/** The milestone bucket key for an entry — its title, or `Uncategorized` when absent/blank. */
const milestoneKey = (milestone: string | undefined): string => {
	if (milestone === undefined) return UNCATEGORIZED;
	const trimmed = milestone.trim();
	return trimmed === "" ? UNCATEGORIZED : trimmed;
};

/** The `type:*` bucket key for an entry — a known type, or `Uncategorized` otherwise. */
const typeKey = (type: string | undefined): string => {
	if (type === undefined) return UNCATEGORIZED;
	const trimmed = type.trim();
	return (TYPE_ORDER as ReadonlyArray<string>).includes(trimmed) && trimmed !== UNCATEGORIZED
		? trimmed
		: UNCATEGORIZED;
};

/** A `type:*` bucket with its entries, in `TYPE_ORDER`. */
export interface TypeGroup {
	readonly type: string;
	readonly entries: ReadonlyArray<ShipEntry>;
}

/** A milestone bucket with its type groups. */
export interface MilestoneGroup {
	readonly milestone: string;
	readonly types: ReadonlyArray<TypeGroup>;
}

/** A top-level section with its milestone groups. */
export interface SectionGroup {
	readonly section: Section;
	readonly milestones: ReadonlyArray<MilestoneGroup>;
}

/**
 * Group entries product/infra → milestone → type, totally and losslessly. Milestones sort
 * with a real title before the trailing `Uncategorized`, then alphabetically among titles;
 * types follow `TYPE_ORDER`. Empty buckets are omitted; input order is preserved within a
 * type bucket. Every input entry lands in exactly one leaf — the count is conserved.
 */
export const groupEntries = (entries: ReadonlyArray<ShipEntry>): ReadonlyArray<SectionGroup> => {
	// section -> milestone -> type -> entries
	const bySection = new Map<Section, Map<string, Map<string, ShipEntry[]>>>();
	for (const entry of entries) {
		const section = resolveSection(entry);
		const mKey = milestoneKey(entry.milestone);
		const tKey = typeKey(entry.type);
		const milestones = bySection.get(section) ?? new Map<string, Map<string, ShipEntry[]>>();
		bySection.set(section, milestones);
		const types = milestones.get(mKey) ?? new Map<string, ShipEntry[]>();
		milestones.set(mKey, types);
		const bucket = types.get(tKey) ?? [];
		types.set(tKey, bucket);
		bucket.push(entry);
	}

	const orderMilestones = (keys: ReadonlyArray<string>): ReadonlyArray<string> => {
		const named = keys.filter((k) => k !== UNCATEGORIZED).sort((a, b) => a.localeCompare(b));
		return keys.includes(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : named;
	};

	return SECTION_ORDER.flatMap((section) => {
		const milestones = bySection.get(section);
		if (!milestones || milestones.size === 0) return [];
		const milestoneGroups: MilestoneGroup[] = orderMilestones([...milestones.keys()]).flatMap(
			(mKey) => {
				const types = milestones.get(mKey);
				if (!types || types.size === 0) return [];
				const typeGroups: TypeGroup[] = TYPE_ORDER.flatMap((tKey) => {
					const bucket = types.get(tKey);
					return bucket && bucket.length > 0 ? [{type: tKey, entries: bucket}] : [];
				});
				return typeGroups.length > 0 ? [{milestone: mKey, types: typeGroups}] : [];
			},
		);
		return milestoneGroups.length > 0 ? [{section, milestones: milestoneGroups}] : [];
	});
};

/** The `(#NNN)` backlink — the merged PR (always present) is the primary reference. */
const backlink = (entry: ShipEntry): string => `(#${entry.pr})`;

const renderEntry = (entry: ShipEntry): string => `- ${entry.title} ${backlink(entry)}`;

const typeLabel = (type: string): string => TYPE_LABEL[type] ?? type;

/**
 * Render a founder-facing ship digest for a window: a `# Ship digest — since … → until`
 * heading, then a `## Product` / `## Infra` section per non-empty section, each with
 * `### <milestone>` groups and `#### <Type>` blocks. An empty window emits the heading plus
 * a "nothing shipped" note (an empty window is a fact, not an error).
 */
export const deriveShipDigest = (
	entries: ReadonlyArray<ShipEntry>,
	window: DigestWindow,
): string => {
	const head = `# Ship digest — ${window.since} → ${window.until}`;
	const sections = groupEntries(entries);
	if (sections.length === 0) {
		return `${head}\n\n_Nothing shipped in this window._\n`;
	}
	const sectionBlocks = sections.map((sectionGroup) => {
		const milestoneBlocks = sectionGroup.milestones.map((milestoneGroup) => {
			const typeBlocks = milestoneGroup.types.map((typeGroup) => {
				const lines = typeGroup.entries.map(renderEntry).join("\n");
				return `#### ${typeLabel(typeGroup.type)}\n\n${lines}`;
			});
			return `### ${milestoneGroup.milestone}\n\n${typeBlocks.join("\n\n")}`;
		});
		return `## ${sectionGroup.section}\n\n${milestoneBlocks.join("\n\n")}`;
	});
	return `${head}\n\n${sectionBlocks.join("\n\n")}\n`;
};
