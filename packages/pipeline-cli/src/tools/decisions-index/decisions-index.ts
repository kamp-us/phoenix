/**
 * `@kampus/decisions-index` core — pure, IO-free derivation of the ADR map(s) from the
 * `.decisions/NNNN-*.md` files. Each file's YAML front-matter (`id`/`title`/`status`/`date`)
 * is the single source of truth; the compact ambient map (`renderCompact`, ADR 0126) and the
 * legacy markdown table (`renderIndex`) are derived, ordered by `id` ascending. There is no
 * committed `index.md` (ADR 0126, supersedes 0066's storage half); the legacy builders are
 * retained only for the `generate`/`check` surfaces.
 *
 * Two load-bearing points, both pinned by the unit tests:
 *  - `title`/`status` render VERBATIM — they may carry inline markdown (a linked
 *    `superseded by [0009](…)`), so the front-matter is the curated display text.
 *  - The ADR number lives on two axes that must agree — the filename `NNNN[a]` prefix and
 *    the front-matter `id`. `parseAdrFile` enforces prefix == `id` (`NumberMismatchError`),
 *    which for free upgrades the id-keyed `findDuplicateId` into a filename-collision guard
 *    at `check` time. This is the within-tree half of #1471; two stale concurrent PR branches
 *    each adding `0114-*.md` are out of scope until both land on `main` (see ADR 0066 / #1471).
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

/**
 * How many digits `next` zero-pads to — the width every existing ADR filename/`id`
 * already carries (`0151`, not `151`). One named constant so the allocator and any
 * future consumer agree on the padding.
 */
export const ADR_ID_WIDTH = 4;

/**
 * The next free ADR number, zero-padded to {@link ADR_ID_WIDTH} — `max(numeric id) + 1`
 * (empty set → `0001`). The deterministic allocator replacing an eyeballed `.decisions/`,
 * which goes stale or races two authors onto the same guess (#2064). A lettered id (`0034a`,
 * a supersede-in-place variant) shares its base numeric, so it never advances allocation. This
 * is an allocator, NOT a collision guard: the rare simultaneous collision is still caught by
 * `validate` (`findDuplicateId`) on merge — the two together are collision-proof (#2064).
 */
export const nextAdrNumber = (entries: ReadonlyArray<AdrEntry>): string => {
	let max = 0;
	for (const e of entries) {
		const [n] = idSortKey(e.id);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return String(max + 1).padStart(ADR_ID_WIDTH, "0");
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
 * Render the ambient compact ADR map: one line per ADR, `id · title · status`, sorted
 * ascending by id (ADR 0126). No table, links, or committed file — surfaced on demand via
 * `pipeline-cli decisions-index compact` (ADR 0129 dropped the SessionStart hook).
 * `title`/`status` render verbatim, the same source-of-truth as the table rows.
 */
export const renderCompact = (entries: ReadonlyArray<AdrEntry>): string =>
	sortEntries(entries)
		.map((e) => `${e.id} · ${e.title} · ${e.status}`)
		.join("\n");

/** Parse every file and reject a duplicate id — the shared prefix of both builders. */
const buildEntries = (files: ReadonlyArray<AdrFile>): ReadonlyArray<AdrEntry> => {
	const entries = files.map(parseAdrFile);
	const dup = findDuplicateId(entries);
	if (dup) throw dup;
	return entries;
};

/**
 * Build the index markdown from the raw `.decisions/` files. Parses every file,
 * fails on a duplicate id (`DuplicateIdError`) or a malformed file
 * (`FrontmatterError`), and otherwise returns the deterministically-ordered table.
 */
export const buildIndex = (files: ReadonlyArray<AdrFile>): string =>
	renderIndex(buildEntries(files));

/**
 * Build the compact ambient map from the raw `.decisions/` files (ADR 0126). Same
 * parse + duplicate-id guard as `buildIndex`, rendered as the one-line-per-ADR map
 * instead of the markdown table.
 */
export const buildCompact = (files: ReadonlyArray<AdrFile>): string =>
	renderCompact(buildEntries(files));

/**
 * The next free ADR number from the raw `.decisions/` files (#2064). Parses every
 * file through the same `buildEntries` prefix as `buildIndex`/`buildCompact` — so it
 * inherits the duplicate-id / number-mismatch guard, refusing to allocate over an
 * already-broken tree — then hands the derived number to `nextAdrNumber`.
 */
export const buildNext = (files: ReadonlyArray<AdrFile>): string =>
	nextAdrNumber(buildEntries(files));
