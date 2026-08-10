/**
 * The corpus as a fact about a tree: which docs are there, how each is registered, and which index
 * rows point at nothing this directory holds.
 *
 * **Registration is three-valued, and the third value is what keeps a false negative out.**
 * `unknown` means registration could not be determined at all — the index is absent, or holds no
 * markdown table. Rendering that as `unregistered` would report a defect this verb never proved, and
 * would send a caller to add rows to a file that cannot hold them.
 */
import type {ParsedIndex} from "./index-table.ts";

export type Registration = "registered" | "unregistered" | "unknown";

/**
 * `absent` — the directory is not in the tree. `none` — it is, and holds no doc. `library` — it
 * holds at least one. All three are facts at exit `0`: the two empty ones are the adopting-repo
 * case, and refusing there would leave a repo unable to write its first pattern doc.
 */
export type CorpusOutcome = "library" | "none" | "absent";

/** One doc, before its history is read. */
export interface CorpusMember {
	readonly slug: string;
	readonly registration: Registration;
	/** The exact heading its row sits under, or `-` when the registration is not `registered`. */
	readonly section: string;
}

/** An index row whose first cell links a target that is not a doc in the directory. */
export interface DanglingRow {
	readonly target: string;
	readonly section: string;
}

/**
 * The doc slugs among a directory listing, sorted ascending byte-wise.
 *
 * `index.md` is the registry rather than a member of the corpus, so it is excluded — v1's
 * `list-pattern-docs.sh` listed it as a pattern doc.
 */
export const docSlugs = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	names
		.filter((n) => n.endsWith(".md") && n !== "index.md")
		.map((n) => n.slice(0, -".md".length))
		.sort();

export interface CorpusReading {
	readonly outcome: CorpusOutcome;
	readonly members: ReadonlyArray<CorpusMember>;
	readonly dangling: ReadonlyArray<DanglingRow>;
	readonly unregistered: number;
	readonly unknown: number;
}

/**
 * Fold the directory listing and the index into the corpus reading.
 *
 * `index` is `null` when the index is absent or holds no parseable table — the `unknown` case. It
 * yields **no** dangling rows for the same reason it yields no registrations: nothing was parsed, so
 * nothing was proven either way.
 */
export const readCorpus = (input: {
	readonly present: boolean;
	readonly names: ReadonlyArray<string>;
	readonly index: ParsedIndex | null;
}): CorpusReading => {
	if (!input.present) {
		return {outcome: "absent", members: [], dangling: [], unregistered: 0, unknown: 0};
	}
	const slugs = docSlugs(input.names);
	if (slugs.length === 0) {
		return {outcome: "none", members: [], dangling: [], unregistered: 0, unknown: 0};
	}

	const {index} = input;
	if (index === null) {
		return {
			outcome: "library",
			members: slugs.map((slug) => ({slug, registration: "unknown" as const, section: "-"})),
			dangling: [],
			unregistered: 0,
			unknown: slugs.length,
		};
	}

	const docNames = new Set(slugs.map((slug) => `${slug}.md`));
	const sectionOf = new Map<string, string>();
	for (const row of index.rows) {
		if (row.member !== null && docNames.has(row.member) && !sectionOf.has(row.member)) {
			sectionOf.set(row.member, row.section);
		}
	}

	const members = slugs.map((slug): CorpusMember => {
		const section = sectionOf.get(`${slug}.md`);
		return section === undefined
			? {slug, registration: "unregistered", section: "-"}
			: {slug, registration: "registered", section};
	});

	const dangling = index.rows
		.filter((row) => row.target !== null && (row.member === null || !docNames.has(row.member)))
		.map((row): DanglingRow => ({target: row.target ?? "", section: row.section}));

	return {
		outcome: "library",
		members,
		dangling,
		unregistered: members.filter((m) => m.registration === "unregistered").length,
		unknown: 0,
	};
};
