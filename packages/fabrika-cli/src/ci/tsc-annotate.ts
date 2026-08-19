/**
 * `ci annotate` pure core — turn tsc/tsgo diagnostics into GitHub `::error` workflow
 * commands so a failing CI typecheck renders inline on the PR diff (#3873). IO-free and
 * total: every decision is a deterministic transform over already-captured text.
 *
 * Three non-obvious facts the parser is built around, all observed from a real
 * `pnpm turbo run typecheck` failure rather than assumed:
 *
 *   1. A diagnostic's path is relative to the PACKAGE directory (turbo runs each task with
 *      cwd = the package dir), but GitHub resolves an annotation's `file=` against the REPO
 *      ROOT. So which package a line belongs to is not cosmetic — it is the only thing that
 *      makes the annotation land on the right file. Hence `WorkspaceMember`.
 *   2. turbo says which package a line belongs to in TWO different ways, and both must be
 *      read: a per-line `<package-name>:<task>: ` prefix in its streamed mode, and — the
 *      mode CI actually gets — a GROUPED mode where a `<package-name>:<task>` header (bare,
 *      or as `::group::…`) is printed once and the task's own lines follow UNPREFIXED. A
 *      parser that only knew the per-line prefix silently annotated a package-relative path
 *      as if it were repo-relative under CI. Observed, not assumed.
 *   3. tsc emits its plain `path(line,col): error TSxxxx: message` form when stdout is not
 *      a TTY (always so under turbo in CI). The `path:line:col - error …` pretty form is
 *      accepted too, so a TTY-ish runner can't silently turn every annotation off.
 */

/** A pnpm workspace member: its package name (turbo's line prefix) and its repo-relative dir. */
export interface WorkspaceMember {
	readonly name: string;
	readonly dir: string;
}

/** One parsed diagnostic, with `file` already re-rooted to be repo-relative. */
export interface TscDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly severity: "error" | "warning";
	readonly code: string;
	readonly message: string;
}

export interface AnnotateContext {
	readonly members: ReadonlyArray<WorkspaceMember>;
	/** Absolute repo root, when known — only used to make an absolute diagnostic path repo-relative. */
	readonly root?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR escapes is the point.
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

const PLAIN = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
const PRETTY = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

const strip = (raw: string): string => raw.replace(ANSI_SGR, "").trimEnd();

/**
 * Strip a `<package-name>:<task>: ` turbo prefix, returning the bare diagnostic text plus
 * the repo-relative dir its paths are relative to (`undefined` when there was no prefix —
 * the caller then falls back to the enclosing group's package, if any).
 */
const stripTurboPrefix = (
	line: string,
	members: ReadonlyArray<WorkspaceMember>,
): {readonly text: string; readonly base: string | undefined} => {
	for (const member of members) {
		const marker = `${member.name}:`;
		if (!line.startsWith(marker)) continue;
		const rest = line.slice(marker.length);
		const taskEnd = rest.indexOf(": ");
		if (taskEnd === -1) continue;
		return {text: rest.slice(taskEnd + 2), base: member.dir};
	}
	return {text: line, base: undefined};
};

/**
 * In turbo's grouped mode (what CI gets) a `<package-name>:<task>` header — bare or as a
 * `::group::` — opens a run of UNPREFIXED lines belonging to that package. Returns the
 * package's dir when `raw` opens such a group, `""` when it closes one, else `undefined`.
 */
export const groupBaseFor = (
	raw: string,
	members: ReadonlyArray<WorkspaceMember>,
): string | undefined => {
	const text = strip(raw)
		.trimStart()
		.replace(/^::group::/, "");
	if (text === "::endgroup::") return "";
	for (const member of members) {
		// `<name>:<task>` / `<name>#<task>` and nothing else — a per-line prefix has content after it.
		if (new RegExp(`^${escapeRegExp(member.name)}[:#][A-Za-z0-9_.-]+$`).test(text)) {
			return member.dir;
		}
	}
	return undefined;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const repoRelative = (file: string, base: string, root: string | undefined): string => {
	const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
	if (normalized.startsWith("/")) {
		if (root === undefined) return normalized;
		const prefix = root.endsWith("/") ? root : `${root}/`;
		return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
	}
	return base === "" ? normalized : `${base}/${normalized}`;
};

/**
 * Parse one output line into a diagnostic, or `undefined` when it isn't one. `groupBase` is
 * the repo-relative dir of the enclosing turbo group, used when the line carries no prefix
 * of its own.
 */
export const parseDiagnostic = (
	raw: string,
	context: AnnotateContext,
	groupBase = "",
): TscDiagnostic | undefined => {
	const {text, base} = stripTurboPrefix(strip(raw), context.members);
	const match = PLAIN.exec(text) ?? PRETTY.exec(text);
	if (match === null) return undefined;
	// Every group is non-optional in both patterns, so a match populates all seven; `?? ""`
	// only discharges `noUncheckedIndexedAccess`, it is not a reachable fallback.
	const [, file = "", line = "", column = "", severity = "", code = "", message = ""] = match;
	return {
		file: repoRelative(file, base ?? groupBase, context.root),
		line: Number(line),
		column: Number(column),
		severity: severity === "warning" ? "warning" : "error",
		code,
		message,
	};
};

// Workflow-command escaping, per GitHub's documented rules: `%`/CR/LF everywhere, plus
// `:` and `,` inside a property value (they are the property separators).
const escapeData = (value: string): string =>
	value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

const escapeProperty = (value: string): string =>
	escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** Render one diagnostic as the `::error file=…,line=…,col=…::message` workflow command. */
export const renderWorkflowCommand = (diagnostic: TscDiagnostic): string =>
	`::${diagnostic.severity} file=${escapeProperty(diagnostic.file)},line=${diagnostic.line},col=${diagnostic.column}::${escapeData(`${diagnostic.code}: ${diagnostic.message}`)}`;

/**
 * Map a whole captured typecheck output to its workflow commands, in first-seen order and
 * deduplicated (an `apps/*` package typechecks several overlapping tsconfigs, so the same
 * diagnostic can surface twice).
 */
export const annotationsFor = (output: string, context: AnnotateContext): ReadonlyArray<string> => {
	const seen = new Set<string>();
	let groupBase = "";
	for (const raw of output.split("\n")) {
		const opened = groupBaseFor(raw, context.members);
		if (opened !== undefined) {
			groupBase = opened;
			continue;
		}
		const diagnostic = parseDiagnostic(raw, context, groupBase);
		if (diagnostic === undefined) continue;
		seen.add(renderWorkflowCommand(diagnostic));
	}
	return [...seen];
};
