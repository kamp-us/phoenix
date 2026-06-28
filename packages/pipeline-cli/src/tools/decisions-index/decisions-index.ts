/**
 * `@kampus/decisions-index` core — the pure, IO-free derivation of
 * `.decisions/index.md` from the ADR files (ADR 0066).
 *
 * The single source of truth is each `.decisions/NNNN-*.md` file's YAML
 * front-matter (`id`, `title`, `status`, `date`); the index table is *derived*
 * output, deterministically ordered by `id` ascending. Two doc PRs that add two
 * different ADR files no longer share a textual anchor (the tail of the table),
 * so they cannot collide on `index.md` — the friction ADR 0066 removes.
 *
 * `buildIndex` folds the sibling problem in: a **duplicate `id`** across files is
 * a `DuplicateIdError`, so the same gate that catches a stale index catches two
 * same-numbered ADR files coexisting on `main`.
 *
 * The ADR number lives on **two axes** that must agree: the filename `NNNN[a]`
 * prefix (what `/adr` allocates and what humans/git key on) and the front-matter
 * `id`. `parseAdrFile` enforces filename-prefix == `id` (`NumberMismatchError`), so
 * the two can never drift. That single invariant upgrades the front-matter-keyed
 * `findDuplicateId` into a **filename-NNNN** duplicate guard for free: two files
 * sharing a `0114-*.md` prefix necessarily share `id: 0114` (or one mismatches its
 * own filename and is rejected first), so the collision the ledger's filename
 * primary key suffers is caught at `check` time. This is the within-tree half of
 * the #1471 fix; the residual it does NOT catch is two *stale* concurrent PR
 * branches that each add a `0114-*.md` the other can't see — that only becomes a
 * single-tree duplicate once both land on `main`, where the next `check` then fails
 * loudly (a cross-open-PR pre-merge guard is out of scope; see ADR 0066 / #1471).
 *
 * Two non-obvious points, both load-bearing and pinned by the unit tests:
 *  - `title`/`status` render **verbatim** from front-matter — they may carry
 *    inline markdown (a linked `superseded by [0009](…)`), so the front-matter is
 *    the curated display text, not just a bare keyword. Make the file right; the
 *    table mirrors it.
 *  - ordering is numeric-then-suffix so a lettered id like `0034a` sorts between
 *    `0034` and `0035` (a plain string sort would too here, but the explicit
 *    numeric compare keeps it correct if ids ever stop being zero-padded).
 */

export interface AdrEntry {
	/** The ADR id from front-matter, e.g. `0034` or `0034a`. */
	readonly id: string;
	/** Display title, rendered verbatim (may contain inline markdown). */
	readonly title: string;
	/** Display status, rendered verbatim (may contain inline markdown links). */
	readonly status: string;
	/** ISO date string, rendered verbatim. */
	readonly date: string;
	/** The file the index row links to, e.g. `0034-fate-native-sse-protocol.md`. */
	readonly file: string;
}

/** A `.decisions/` file handed to the core: its base name + full text. */
export interface AdrFile {
	/** Base name only, e.g. `0034-fate-native-sse-protocol.md` (no directory). */
	readonly file: string;
	/** The file's full UTF-8 contents. */
	readonly text: string;
}

export class DuplicateIdError extends Error {
	readonly id: string;
	readonly files: ReadonlyArray<string>;
	constructor(id: string, files: ReadonlyArray<string>) {
		super(`duplicate ADR id ${id} in: ${files.join(", ")}`);
		this.name = "DuplicateIdError";
		this.id = id;
		this.files = files;
	}
}

export class FrontmatterError extends Error {
	readonly file: string;
	constructor(file: string, reason: string) {
		super(`${file}: ${reason}`);
		this.name = "FrontmatterError";
		this.file = file;
	}
}

/**
 * A file whose filename `NNNN[a]` prefix disagrees with its front-matter `id`. The
 * two name the same ADR number on two axes; letting them drift would let a
 * filename-NNNN collision hide behind distinct `id`s (and vice-versa), so the
 * invariant is enforced at parse time and this is the rejection.
 */
export class NumberMismatchError extends Error {
	readonly file: string;
	readonly filePrefix: string;
	readonly id: string;
	constructor(file: string, filePrefix: string, id: string) {
		super(
			`${file}: filename number \`${filePrefix}\` does not match front-matter \`id: ${id}\` ` +
				"(the filename prefix and the front-matter id must name the same ADR number)",
		);
		this.name = "NumberMismatchError";
		this.file = file;
		this.filePrefix = filePrefix;
		this.id = id;
	}
}

const FRONTMATTER_FIELDS = ["id", "title", "status", "date"] as const;

/**
 * Strip one layer of surrounding quotes from a YAML scalar. A double-quoted value
 * also has its `\"` / `\\` escapes resolved (YAML double-quote semantics), so a
 * title quoted to protect an inner `"by path"` round-trips back to the literal text.
 * A single-quoted value is taken verbatim (we never emit `''` escapes).
 */
const unquote = (value: string): string => {
	const v = value.trim();
	if (v.length >= 2) {
		const first = v[0];
		const last = v[v.length - 1];
		if (first === '"' && last === '"') {
			return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
		}
		if (first === "'" && last === "'") {
			return v.slice(1, -1);
		}
	}
	return v;
};

/**
 * Parse the four index-relevant fields out of a `---`-delimited YAML block.
 * Only the top-level `id`/`title`/`status`/`date` scalars are read; everything
 * else (tags, body) is ignored. Returns the fields present; the caller validates.
 */
export const parseFrontmatter = (
	text: string,
): Partial<Record<(typeof FRONTMATTER_FIELDS)[number], string>> => {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match || match[1] === undefined) return {};
	const block = match[1];
	const out: Partial<Record<(typeof FRONTMATTER_FIELDS)[number], string>> = {};
	for (const line of block.split(/\r?\n/)) {
		const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/);
		if (!kv || kv[1] === undefined || kv[2] === undefined) continue;
		const key = kv[1];
		if ((FRONTMATTER_FIELDS as ReadonlyArray<string>).includes(key)) {
			out[key as (typeof FRONTMATTER_FIELDS)[number]] = unquote(kv[2]);
		}
	}
	return out;
};

/**
 * The `NNNN[a]` ADR number at the head of a `.decisions/` base name
 * (`0114-foo.md` → `0114`, `0034a-bar.md` → `0034a`), or `null` if the name does
 * not lead with a number-slug prefix. Pure: the base name is the only input.
 */
export const numberFromFile = (file: string): string | null => {
	const m = file.match(/^(\d+[A-Za-z]*)-/);
	return m?.[1] ?? null;
};

/**
 * Parse one ADR file into an entry. Throws `FrontmatterError` if an index field is
 * missing, or `NumberMismatchError` if the filename `NNNN[a]` prefix disagrees with
 * the front-matter `id` — the invariant that keeps the filename and front-matter
 * naming the same ADR number (so `findDuplicateId` also guards filename collisions).
 */
export const parseAdrFile = ({file, text}: AdrFile): AdrEntry => {
	const fm = parseFrontmatter(text);
	for (const field of FRONTMATTER_FIELDS) {
		if (fm[field] === undefined || fm[field] === "") {
			throw new FrontmatterError(file, `missing front-matter field \`${field}\``);
		}
	}
	const id = fm.id as string;
	const filePrefix = numberFromFile(file);
	if (filePrefix !== null && filePrefix !== id) {
		throw new NumberMismatchError(file, filePrefix, id);
	}
	return {
		id,
		title: fm.title as string,
		status: fm.status as string,
		date: fm.date as string,
		file,
	};
};

/** Split an id into [numeric, letterSuffix] for ordering, e.g. `0034a` → [34, "a"]. */
const idSortKey = (id: string): [number, string] => {
	const m = id.match(/^(\d+)([A-Za-z]*)$/);
	if (!m || m[1] === undefined) return [Number.POSITIVE_INFINITY, id];
	return [Number.parseInt(m[1], 10), m[2] ?? ""];
};

/** Entries sorted ascending by id (numeric part, then letter suffix). */
export const sortEntries = (entries: ReadonlyArray<AdrEntry>): ReadonlyArray<AdrEntry> =>
	[...entries].sort((a, b) => {
		const [an, as] = idSortKey(a.id);
		const [bn, bs] = idSortKey(b.id);
		if (an !== bn) return an - bn;
		return as < bs ? -1 : as > bs ? 1 : 0;
	});

/** First duplicated id across the entries (lowest by sort order), or null if all unique. */
export const findDuplicateId = (entries: ReadonlyArray<AdrEntry>): DuplicateIdError | null => {
	const byId = new Map<string, string[]>();
	for (const e of entries) {
		const files = byId.get(e.id) ?? [];
		files.push(e.file);
		byId.set(e.id, files);
	}
	const dups = [...byId.entries()].filter(([, files]) => files.length > 1);
	if (dups.length === 0) return null;
	dups.sort((a, b) => {
		const [an] = idSortKey(a[0]);
		const [bn] = idSortKey(b[0]);
		return an - bn;
	});
	const [id, files] = dups[0] as [string, string[]];
	return new DuplicateIdError(id, files);
};

/**
 * Walk up from `start` for the first ancestor for which `hasMarker(dir)` holds,
 * returning that directory; or `null` if the filesystem root is reached without a
 * hit. Pure (the IO — "does this dir carry a marker?" — is the injected predicate),
 * so the upward-walk logic is unit-testable without touching disk. The caller
 * resolves `.decisions` against the returned root.
 *
 * `dirname` is the only path op: `dirname("/") === "/"` is the fixpoint that ends
 * the walk. The caller passes already-resolved (absolute) directories.
 */
export const findRootDir = (
	start: string,
	hasMarker: (dir: string) => boolean,
	dirname: (p: string) => string,
): string | null => {
	let dir = start;
	for (;;) {
		if (hasMarker(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

const renderRow = (e: AdrEntry): string =>
	`| [${e.id}](${e.file}) | ${e.title} | ${e.status} | ${e.date} |`;

/**
 * Render the canonical `.decisions/index.md` from sorted entries. The preamble +
 * table header are fixed; rows are one per ADR. The trailing newline matches a
 * POSIX text file (the committed index ends in a single `\n`).
 */
export const renderIndex = (entries: ReadonlyArray<AdrEntry>): string => {
	const sorted = sortEntries(entries);
	const lines = [
		"# Decisions",
		"",
		"One row per ADR. Read the file for the why.",
		"",
		"| # | Title | Status | Date |",
		"|---|-------|--------|------|",
		...sorted.map(renderRow),
	];
	return `${lines.join("\n")}\n`;
};

/**
 * Build the index markdown from the raw `.decisions/` files. Parses every file,
 * fails on a duplicate id (`DuplicateIdError`) or a malformed file
 * (`FrontmatterError`), and otherwise returns the deterministically-ordered table.
 */
export const buildIndex = (files: ReadonlyArray<AdrFile>): string => {
	const entries = files.map(parseAdrFile);
	const dup = findDuplicateId(entries);
	if (dup) throw dup;
	return renderIndex(entries);
};
