/**
 * The reader for every fabrika skill's `## Required repo files` table (#5049) — the declaration each
 * skill makes about the repo surfaces it leans on.
 *
 * The table is **externally-authorable text**: fabrika installs into repos that are not phoenix
 * (#4776), so this parser reports what it finds rather than refusing on it. Nothing is normalized,
 * guessed at, or dropped — a dropped row is a declaration the reader will never know exists.
 *
 * **Parse by cell position, never by scanning the row for a bolded token.** The *second* cell is
 * prose that may itself contain bolded words (`plan-epic` writes `` `POST …/labels` **creates** ``
 * there, beside a third cell reading `**fail-loud**`), so a section-wide scan reports a disposition
 * that is not one — as it did during the contract's own authoring.
 */

/** The three words every landed skill uses. A fourth is counted off-vocabulary, never refused. */
export const CANONICAL_DISPOSITIONS: ReadonlyArray<string> = ["fail-loud", "degrade", "bootstrap"];

/** The heading whose table this reads. */
export const SECTION_HEADING = "## Required repo files";

/**
 * What a declared row's first cell names, and therefore what — if anything — can be probed.
 *
 * `Unprobeable` is a first-class outcome, not a parse failure: *"the `package.json` scripts
 * `typecheck` and `lint:worktree`"* and *"a merge queue enabled on the base branch"* are real
 * declarations no filesystem or label probe settles, and rendering them `present` off some file's
 * existence is the false positive this state exists to prevent.
 */
export type Subject =
	| {readonly _tag: "Path"; readonly path: string}
	/** A path whose mere existence does not satisfy the row — it must contain {@link contains}. */
	| {readonly _tag: "PathContaining"; readonly path: string; readonly contains: string}
	| {readonly _tag: "Labels"; readonly labels: ReadonlyArray<string>}
	| {readonly _tag: "Unprobeable"; readonly reason: string};

export interface DeclaredRow {
	/** The `` `id:<slug>` `` token in the first cell, or `-`. No slug is ever derived from prose. */
	readonly surfaceId: string;
	readonly disposition: string;
	/** The third cell after its bolded disposition — what the declaring skill says happens. */
	readonly consequence: string;
	readonly subject: Subject;
}

const ID_TOKEN = /`id:([a-z0-9-]+)`/;
const BACKTICKED = /`([^`]+)`/g;
/**
 * The label grammar, closed on **fabrika's own** board facets rather than on any `word:word`.
 *
 * Left open, `lint:worktree` — a `package.json` script named in `build`'s table — reads as a label
 * and the row reports a missing label that was never declared. The facets here are the ones this
 * group itself creates and counts (`status bootstrap label-taxonomy` and `issue-shape-markers`,
 * `status board`'s buckets), so the set is fabrika's vocabulary, not a guess at the host repo's.
 */
const LABEL_TOKEN =
	/^(?:(?:status|type|ready-for|wayfinding|prototyping|grilling):[a-z0-9._-]+|p\d+)$/;
const PATH_TOKEN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const SEPARATOR_CELL = /^:?-{3,}:?$/;
/** The one keyword that qualifies an opening path by its content. See {@link classifySubject}. */
const COVERING = /^`([^`]+)`\s+covering\s+`([^`]+)`/;

const isPathToken = (token: string): boolean =>
	PATH_TOKEN.test(token) && (token.includes("/") || /\.[A-Za-z0-9]+$/.test(token));

/** The cells of one markdown table row, outer pipes dropped. */
export const rowCells = (line: string): ReadonlyArray<string> => {
	const trimmed = line.trim();
	const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return inner.split("|").map((cell) => cell.trim());
};

/**
 * What the first cell declares.
 *
 * The rule is positional and stated so two implementers cannot ship two answers: a cell naming any
 * **label-shaped** token declares labels; otherwise a cell of the form *"`<path>` covering
 * `<token>`"* declares a content-qualified path; otherwise a cell that *opens* with a backticked
 * path declares that path; everything else is unprobeable. A path named mid-sentence is a qualifier
 * on some other subject — *"the `package.json` scripts …"*, *"a dev server …
 * `design-harness.json`'s `command`"* — and probing it would answer a question the row did not ask.
 *
 * **`covering` is a named case, not the regex reaching one token further.** The content-qualified
 * form is the only one where the words after the opening path are part of what the row requires,
 * so it is closed on that single keyword: read as "a path plus whatever token follows it",
 * *"`ROADMAP.md` with a `## Focus` section"* would demand a substring nobody declared. Without the
 * case, *"`.gitignore` covering `.fabrika/`"* rendered `present` off the existence of any
 * `.gitignore` at all (#5777) — `Unprobeable`'s own false positive, arriving through the branch
 * that does probe.
 */
export const classifySubject = (cell: string): Subject => {
	const withoutId = cell.replace(ID_TOKEN, "").trim();
	const tokens = [...withoutId.matchAll(BACKTICKED)].map((m) => m[1] ?? "");
	const labels = tokens.filter((token) => LABEL_TOKEN.test(token));
	if (labels.length > 0) return {_tag: "Labels", labels};
	const covering = COVERING.exec(withoutId);
	if (covering?.[1] !== undefined && covering[2] !== undefined && isPathToken(covering[1])) {
		return {_tag: "PathContaining", path: covering[1], contains: covering[2]};
	}
	const opening = /^`([^`]+)`/.exec(withoutId);
	if (opening?.[1] !== undefined && isPathToken(opening[1])) {
		return {_tag: "Path", path: opening[1]};
	}
	return {
		_tag: "Unprobeable",
		reason: `declared subject is ${withoutId.replace(/`/g, "")} — not a path or a label`,
	};
};

/** The disposition word and the consequence sentence behind it, off the third cell. */
export const splitDisposition = (cell: string): {disposition: string; consequence: string} => {
	const bolded = /^\*\*([^*]+)\*\*\s*(?:—|–|-|:)?\s*([\s\S]*)$/.exec(cell.trim());
	if (bolded?.[1] === undefined) return {disposition: "-", consequence: cell.trim()};
	return {disposition: bolded[1].trim(), consequence: (bolded[2] ?? "").trim()};
};

/** The lines of the `## Required repo files` section, or `null` when the skill declares none. */
export const sectionOf = (text: string): ReadonlyArray<string> | null => {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
	if (start === -1) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^#{1,2} /.test(line));
	return end === -1 ? rest : rest.slice(0, end);
};

/**
 * Every declared row, in table order — or `null` when the skill has no `## Required repo files`
 * section at all, which the caller renders as one `undeclared` row and never as zero rows.
 */
export const parseRequiredFiles = (text: string): ReadonlyArray<DeclaredRow> | null => {
	const section = sectionOf(text);
	if (section === null) return null;
	const tableLines = section.filter((line) => line.trim().startsWith("|"));
	const body = tableLines.filter((line) => !rowCells(line).every((c) => SEPARATOR_CELL.test(c)));
	// The header row is the table's first non-separator row; every row after it is a declaration.
	const rows: DeclaredRow[] = [];
	for (const line of body.slice(1)) {
		const cells = rowCells(line);
		const first = cells[0] ?? "";
		const third = cells[2];
		if (third === undefined) {
			rows.push({
				surfaceId: "-",
				disposition: "-",
				consequence: "-",
				subject: {_tag: "Unprobeable", reason: "row does not carry three cells"},
			});
			continue;
		}
		const {disposition, consequence} = splitDisposition(third);
		rows.push({
			surfaceId: ID_TOKEN.exec(first)?.[1] ?? "-",
			disposition,
			consequence: consequence === "" ? "-" : consequence,
			subject: classifySubject(first),
		});
	}
	return rows;
};
