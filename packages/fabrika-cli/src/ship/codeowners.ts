/**
 * The §CP boundary, derived from `.github/CODEOWNERS` itself — the artifact the merge gate
 * enforces — so this group and the gate read one file and cannot disagree (#981, #4954).
 *
 * Three properties are load-bearing and each has an incident behind it:
 *
 * - **Last match wins, and an owner-less row unsets ownership.** That is GitHub's documented rule
 *   and this repo leans on it: `/packages/pipeline-cli/src/tools/` carries no owner precisely to
 *   un-own the ~60 non-gating tools that a broader row above it would otherwise sweep in.
 * - **A trivial boundary is a printed hold, not a match-everything verdict** — the #4336 adopter
 *   incident and the #4401 empty-capture class.
 * - **The team is parsed, never hardcoded.** `@<org>/<team>` owners are read off the file, so an
 *   adopter repo with a different team, or none, is answered rather than mis-answered.
 */

/** One `pattern owner…` row, in file order. `owners` empty is the ownership-unset idiom. */
export interface OwnerRow {
	readonly pattern: string;
	readonly owners: ReadonlyArray<string>;
}

const TEAM = /^@[^/\s]+\/[^/\s]+$/;

/** The `@org/team` owners this file names, distinct, in first-appearance order. */
export const teamOwnersOf = (rows: ReadonlyArray<OwnerRow>): ReadonlyArray<string> => {
	const seen: string[] = [];
	for (const row of rows) {
		for (const owner of row.owners) {
			if (TEAM.test(owner) && !seen.includes(owner)) seen.push(owner);
		}
	}
	return seen;
};

export const parseCodeowners = (text: string): ReadonlyArray<OwnerRow> => {
	const rows: OwnerRow[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (line === "") continue;
		const [pattern, ...owners] = line.split(/\s+/);
		if (pattern === undefined) continue;
		rows.push({pattern, owners});
	}
	return rows;
};

const escapeSegment = (segment: string): string =>
	segment
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");

/**
 * A CODEOWNERS pattern as a matcher over repo-relative file paths.
 *
 * A trailing `/` is a directory prefix and matches everything beneath it. Everything else matches
 * the path exactly, and additionally as a directory prefix **only when its last segment carries no
 * wildcard** — which is what keeps `/packages/pipeline-cli/src/*` owning the dispatch root and no
 * deeper, the reading that row's own comment pins.
 */
export const matcherFor = (pattern: string): RegExp => {
	let body = pattern;
	const directory = body.endsWith("/");
	if (directory) body = body.slice(0, -1);
	const anchored = body.startsWith("/");
	if (anchored) body = body.slice(1);

	const segments = body.split("/");
	const last = segments.at(-1) ?? "";
	// `**/` and a trailing `**` differ — the first may match no segments at all — so the two are
	// rewritten in that order, through a sentinel no escaped segment can contain.
	const compiled = segments
		.map((segment) => (segment === "**" ? "\u0000" : escapeSegment(segment)))
		.join("/")
		.split("\u0000/")
		.join("(?:.*/)?")
		.split("\u0000")
		.join(".*");

	const prefix = anchored || body.includes("/") ? "^" : "^(?:.*/)?";
	const suffix = directory ? "/.*$" : last.includes("*") || last.includes("?") ? "$" : "(?:/.*)?$";
	return new RegExp(`${prefix}${compiled}${suffix}`);
};

/** The owners in force for one path: the **last** matching row's, empty when none matches. */
export const ownersOf = (
	rows: ReadonlyArray<OwnerRow>,
	path: string,
): ReadonlyArray<string> | null => {
	let owners: ReadonlyArray<string> | null = null;
	for (const row of rows) {
		if (matcherFor(row.pattern).test(path)) owners = row.owners;
	}
	return owners;
};

/** The four states `ship scope` prints on its `cp` line. */
export type CpState = "control-plane" | "content-undetermined" | "not-control-plane" | "unknown";

/** Rows that own at least one path to a team — the boundary's real extent. */
const teamOwnedRows = (
	rows: ReadonlyArray<OwnerRow>,
	teams: ReadonlyArray<string>,
): ReadonlyArray<OwnerRow> =>
	rows.filter((row) => row.owners.some((owner) => teams.includes(owner)));

/** A row that owns everything — the match-everything sentinel a boundary must never be. */
const coversEverything = (row: OwnerRow): boolean =>
	["*", "/*", "**", "/**", "**/*"].includes(row.pattern);

/**
 * The four-state routing input.
 *
 * `unknown` and `content-undetermined` are HOLD states — the skill treats them as §CP until proven
 * otherwise. Neither is a verdict on the gated question; the merge gate still owns that.
 */
export const classify = (rows: ReadonlyArray<OwnerRow>, files: ReadonlyArray<string>): CpState => {
	const teams = teamOwnersOf(rows);
	const owned = teamOwnedRows(rows, teams);
	if (teams.length === 0 || owned.length === 0) return "unknown";
	if (owned.some(coversEverything)) return "unknown";

	for (const file of files) {
		if (ownersOf(rows, file)?.some((owner) => teams.includes(owner)) === true) {
			return "control-plane";
		}
	}
	return files.some((file) => file.startsWith(".decisions/"))
		? "content-undetermined"
		: "not-control-plane";
};

/** `@org/team` split into the two path segments the REST team-members endpoint needs. */
export const splitTeam = (owner: string): {org: string; team: string} | null => {
	const m = /^@([^/\s]+)\/([^/\s]+)$/.exec(owner);
	return m?.[1] === undefined || m[2] === undefined ? null : {org: m[1], team: m[2]};
};
