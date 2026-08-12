/**
 * The shared vocabulary of an ADR record: what its filename means, what its frontmatter says,
 * and which statuses are *live*.
 *
 * fabrika owns this predicate rather than importing one (ADR 0238). The semantics the contract
 * fixes: `accepted` is live, and so is `amended-in-part`, whose unamended remainder still stands;
 * `proposed` is not yet live and `superseded` is no longer. Presence on the base ref is a separate
 * fact from authority — `landed` vs `live` — and conflating them licenses citing 36 of the 233
 * records on `main` that are present and not live.
 */

/** A record filename plus its full text — the unit every pure function here consumes. */
export interface AdrFile {
	/** Base name only, e.g. `0940-only-landed-adrs-may-be-cited.md`. */
	readonly file: string;
	/** The file's full UTF-8 contents. */
	readonly text: string;
}

/**
 * A `NNNN-slug.md` decision record.
 *
 * The corpus carries one lettered variant (`0034a-live-fan-out-options-considered.md`), so the id
 * is the whole `NNNN[a]` prefix rather than four bare digits: a stricter pattern would classify
 * that real file as a record with an unparseable id and make `adr next` refuse on the live repo.
 * The letter never advances allocation — `0034a` shares 34 with `0034` — and it is not addressable
 * by the verbs that take an `<id>`, which the contract restricts to four zero-padded digits.
 */
const RECORD_NAME = /^(\d{4}[a-z]*)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/**
 * A filename that *claims* to be a record — it leads with a digit and ends `.md` — so a name that
 * matches this but not {@link RECORD_NAME} is a malformed record, not a stray file. `index.md` and
 * `README.md` lead with a letter and are simply not records.
 */
const RECORD_CANDIDATE = /^\d.*\.md$/;

/** The `NNNN[a]` id a record filename declares, or `null` when the name is not a record name. */
export const idFromFile = (file: string): string | null => RECORD_NAME.exec(file)?.[1] ?? null;

/** True when the name leads with a digit and ends `.md` — a record or a malformed one. */
export const isRecordCandidate = (file: string): boolean => RECORD_CANDIDATE.test(file);

/** The four-zero-padded-digit id form the `<id>` arguments accept. */
export const isFourDigitId = (id: string): boolean => /^\d{4}$/.test(id);

/** The kebab-case slug form `adr new` accepts. */
export const isKebabSlug = (slug: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

/** A record filename with an id that could not be parsed — the caller turns this into a refusal. */
export interface UnparseableRecord {
	readonly file: string;
}

/** The record filenames in a directory listing, split from the names that are not records at all. */
export const partitionRecordNames = (
	names: ReadonlyArray<string>,
): {readonly records: ReadonlyArray<string>; readonly unparseable: ReadonlyArray<string>} => {
	const records: string[] = [];
	const unparseable: string[] = [];
	for (const name of names) {
		if (idFromFile(name) !== null) records.push(name);
		else if (isRecordCandidate(name)) unparseable.push(name);
	}
	return {records: [...records].sort(), unparseable: [...unparseable].sort()};
};

/** The raw text between a file's leading `---` fences, or `null` when there is no frontmatter. */
export const frontmatterBlock = (text: string): string | null =>
	/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? null;

/** Strip one layer of surrounding quotes from a YAML scalar (double-quote escapes resolved). */
const unquote = (value: string): string => {
	const v = value.trim();
	if (v.length < 2) return v;
	const first = v[0];
	const last = v[v.length - 1];
	if (first === '"' && last === '"') return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
	if (first === "'" && last === "'") return v.slice(1, -1);
	return v;
};

/**
 * The top-level scalars of a `---`-delimited frontmatter block, verbatim after unquoting.
 *
 * `status:` is read verbatim on purpose: it carries inline markdown
 * (`amended-in-part by [0025](0025-…), [0028](0028-…)`) that both `adr resolve`'s `detail` column
 * and `adr amend-in-part`'s list append operate on as text.
 */
export const parseFrontmatter = (text: string): Readonly<Record<string, string>> => {
	const block = frontmatterBlock(text);
	if (block === null) return {};
	const out: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
		if (kv?.[1] === undefined || kv[2] === undefined) continue;
		out[kv[1]] = unquote(kv[2]);
	}
	return out;
};

/** The frontmatter `status:` value verbatim, or `null` when the file declares none. */
export const statusOf = (text: string): string | null => parseFrontmatter(text).status ?? null;

/** The frontmatter `title:` value verbatim, or `""` when the file declares none. */
export const titleOf = (text: string): string => parseFrontmatter(text).title ?? "";

/**
 * Whether a status value means the record is **live** — currently binding law a caller may cite.
 *
 * `accepted` is live. `amended-in-part` is live: an amendment narrows a decision, it does not
 * retire it. Everything else — `proposed`, `superseded`, `superseded-in-part`, `retired`, `moot`,
 * `reference` — is present without being authoritative. The match is on the status line's leading
 * word, because a live status carries its amending links inline after it.
 */
export const isLive = (status: string): boolean => {
	const head = status.trim().toLowerCase();
	return head === "accepted" || head === "amended-in-part" || head.startsWith("amended-in-part by");
};

/** True when the status line declares the record superseded outright (`superseded by …`). */
export const isSuperseded = (status: string): boolean =>
	/^superseded\s+by\b/i.test(status.trim()) || status.trim().toLowerCase() === "superseded";

/** Sort key for an `NNNN[a]` id: the numeric part first, then the letter suffix. */
export const idSortKey = (id: string): readonly [number, string] => {
	const m = /^(\d+)([a-z]*)$/i.exec(id);
	if (m?.[1] === undefined) return [Number.POSITIVE_INFINITY, id];
	return [Number.parseInt(m[1], 10), m[2] ?? ""];
};

/** Ids sorted ascending (numeric part, then letter suffix). */
export const sortIds = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
	[...ids].sort((a, b) => {
		const [an, as] = idSortKey(a);
		const [bn, bs] = idSortKey(b);
		if (an !== bn) return an - bn;
		return as < bs ? -1 : as > bs ? 1 : 0;
	});
