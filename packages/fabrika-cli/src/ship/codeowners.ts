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
 * - **The owners are parsed, never hardcoded.** `@<org>/<team>` and individual `@login` owners are
 *   both read off the file, so an adopter repo with a different team, or with no org at all, is
 *   answered rather than mis-answered. Individual owners count exactly as team owners do (founder
 *   ruling on #5603, built as #6299): GitHub discharges a row when any listed owner approves, and a
 *   personal repo whose owners are all individuals used to classify `unknown` — the HOLD state —
 *   which deadlocked every PR in it.
 */

/** One `pattern owner…` row, in file order. `owners` empty is the ownership-unset idiom. */
export interface OwnerRow {
	readonly pattern: string;
	readonly owners: ReadonlyArray<string>;
}

const TEAM = /^@[^/\s]+\/[^/\s]+$/;
const USER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * An owner that bounds the control plane: `@org/team`, or an individual `@login`.
 *
 * CODEOWNERS also admits a bare email address as an owner. It is not one of these: an email names
 * no GitHub account this group can resolve a roster or an approval against.
 */
const isControlPlaneOwner = (owner: string): boolean => TEAM.test(owner) || USER.test(owner);

/** The control-plane owners this file names, distinct, in first-appearance order. */
export const controlPlaneOwnersOf = (rows: ReadonlyArray<OwnerRow>): ReadonlyArray<string> => {
	const seen: string[] = [];
	for (const row of rows) {
		for (const owner of row.owners) {
			if (isControlPlaneOwner(owner) && !seen.includes(owner)) seen.push(owner);
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

/** The three states `ship scope` prints on its `cp` line. */
export type CpState = "control-plane" | "not-control-plane" | "unknown";

/** Rows that own at least one path to a control-plane owner — the boundary's real extent. */
const ownedRows = (
	rows: ReadonlyArray<OwnerRow>,
	owners: ReadonlyArray<string>,
): ReadonlyArray<OwnerRow> =>
	rows.filter((row) => row.owners.some((owner) => owners.includes(owner)));

/** A row that owns everything — the match-everything sentinel a boundary must never be. */
const coversEverything = (row: OwnerRow): boolean =>
	["*", "/*", "**", "/**", "**/*"].includes(row.pattern);

/**
 * The three-state routing input.
 *
 * `unknown` is the one HOLD state — the skill treats it as §CP until proven otherwise. It is not a
 * verdict on the gated question; the merge gate still owns that.
 *
 * A change set entirely under `.decisions/` is `not-control-plane` (founder ruling, 2026-08-15 on
 * #5531: "adrs shouldn't be control-plane"). What stands behind an ADR PR is the required
 * `governance` verdict floor, not a human approval — see ADR 0274 §2 and
 * `claude-plugins/fabrika/docs/control-plane-classification.md`.
 */
export const classify = (rows: ReadonlyArray<OwnerRow>, files: ReadonlyArray<string>): CpState => {
	const owners = controlPlaneOwnersOf(rows);
	const owned = ownedRows(rows, owners);
	if (owners.length === 0 || owned.length === 0) return "unknown";
	if (owned.some(coversEverything)) return "unknown";

	for (const file of files) {
		if (ownersOf(rows, file)?.some((owner) => owners.includes(owner)) === true) {
			return "control-plane";
		}
	}
	return "not-control-plane";
};

/**
 * `@org/team` split into the two path segments the REST team-members endpoint needs.
 *
 * `null` for an individual `@login` owner, which is the discriminator `ship cp-approval` routes on:
 * a team is expanded through a roster read, a user IS the roster entry and needs no read at all.
 */
export const splitTeam = (owner: string): {org: string; team: string} | null => {
	const m = /^@([^/\s]+)\/([^/\s]+)$/.exec(owner);
	return m?.[1] === undefined || m[2] === undefined ? null : {org: m[1], team: m[2]};
};
