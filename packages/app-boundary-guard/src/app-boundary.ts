/**
 * `@kampus/app-boundary-guard` core — the pure, IO-free verdict for whether any code outside
 * `apps/` reaches an app (#9660, #9727).
 *
 * The rule is the founder ruling on #9646: anything under `apps/` is an app, apps are named
 * `@kampus-apps/*`, and an app is never imported. So a package outside `apps/` may not list an
 * `@kampus-apps/*` name in a dependency field, and no source file outside `apps/` may import an
 * `@kampus-apps/*` specifier or a relative path that resolves under `apps/`.
 *
 * No IO and no runtime dependency: `./bin.ts` lists the tree and hands the texts in here.
 */
import {posix} from "node:path";

export const APP_SCOPE = "@kampus-apps/";

export const APPS_DIR = "apps";

export const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

export type Finding =
	| {
			readonly _tag: "Dependency";
			/** Repo-relative path of the offending `package.json`. */
			readonly manifest: string;
			/** The manifest's own `name`, or its path when it declares none. */
			readonly packageName: string;
			readonly field: DependencyField;
			readonly dependency: string;
	  }
	| {
			readonly _tag: "Import";
			/** Repo-relative path of the importing file. */
			readonly file: string;
			/** 1-based. */
			readonly line: number;
			readonly specifier: string;
	  }
	| {
			readonly _tag: "PathImport";
			/** Repo-relative path of the importing file. */
			readonly file: string;
			/** 1-based. */
			readonly line: number;
			/** The relative specifier as written. */
			readonly specifier: string;
			/** The repo-relative path it resolves to, under `apps/`. */
			readonly resolved: string;
	  };

type NonEmpty<A> = readonly [A, ...ReadonlyArray<A>];

const nonEmpty = <A>(items: ReadonlyArray<A>): NonEmpty<A> | null => {
	const [head, ...rest] = items;
	return head === undefined ? null : [head, ...rest];
};

/**
 * The three answers a scan can give. `Violated` still carries whatever could not be read, because a
 * red is certain whatever else the scan missed; `Clean` is only reachable when nothing was unread.
 */
export type Verdict =
	| {readonly _tag: "Clean"; readonly packages: number; readonly files: number}
	| {
			readonly _tag: "Violated";
			readonly findings: NonEmpty<Finding>;
			readonly unread: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Unknown"; readonly reasons: NonEmpty<string>};

/** A `pnpm-workspace.yaml` `packages:` entry, reduced to the one shape this guard can expand. */
export type WorkspaceGlob =
	| {readonly _tag: "Children"; readonly dir: string}
	| {readonly _tag: "Exact"; readonly dir: string};

export type WorkspaceGlobs =
	| {readonly _tag: "Read"; readonly globs: NonEmpty<WorkspaceGlob>}
	| {readonly _tag: "Unreadable"; readonly reason: string};

const unquote = (value: string): string => {
	const trimmed = value.trim();
	const quote = trimmed[0];
	return (quote === '"' || quote === "'") && trimmed.endsWith(quote)
		? trimmed.slice(1, -1)
		: trimmed;
};

/**
 * `<dir>/*` or a literal `<dir>`. Anything else — a negation, `**`, a brace or a mid-path star —
 * names a member set this guard would have to guess at, so it is refused rather than expanded.
 */
const parseGlob = (raw: string): WorkspaceGlob | null => {
	const glob = raw.replace(/^\.\//, "").replace(/\/$/, "");
	if (glob === "" || glob.startsWith("!")) return null;
	if (glob.endsWith("/*")) {
		const dir = glob.slice(0, -2);
		return /[*?{}[\]!]/.test(dir) ? null : {_tag: "Children", dir};
	}
	return /[*?{}[\]!]/.test(glob) ? null : {_tag: "Exact", dir: glob};
};

/** The `packages:` list of a `pnpm-workspace.yaml`, read as the flat block pnpm writes it. */
export const parseWorkspaceGlobs = (yaml: string): WorkspaceGlobs => {
	const globs: Array<WorkspaceGlob> = [];
	let inPackages = false;
	for (const line of yaml.split("\n")) {
		if (/^\s*(#.*)?$/.test(line)) continue;
		if (!/^\s/.test(line)) {
			if (inPackages) break;
			inPackages = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inPackages) continue;
		const item = /^\s+-\s+(.+?)\s*(#.*)?$/.exec(line);
		if (item === null) {
			return {_tag: "Unreadable", reason: `unexpected line in the packages: block: ${line.trim()}`};
		}
		const raw = unquote(item[1] ?? "");
		const glob = parseGlob(raw);
		if (glob === null) {
			return {
				_tag: "Unreadable",
				reason: `workspace glob \`${raw}\` is not \`<dir>/*\` or \`<dir>\``,
			};
		}
		globs.push(glob);
	}
	const read = nonEmpty(globs);
	return read === null
		? {_tag: "Unreadable", reason: "no packages: entries found"}
		: {_tag: "Read", globs: read};
};

/** A repo-relative path is an app's when it sits under `apps/`. */
export const isApp = (path: string): boolean =>
	path === APPS_DIR || path.startsWith(`${APPS_DIR}/`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Every `@kampus-apps/*` name a parsed `package.json` lists, one finding per field it sits in. */
export const dependencyFindings = (
	manifest: string,
	parsed: Record<string, unknown>,
): ReadonlyArray<Finding> => {
	const packageName = typeof parsed.name === "string" ? parsed.name : manifest;
	return DEPENDENCY_FIELDS.flatMap((field) => {
		const block = parsed[field];
		if (!isRecord(block)) return [];
		return Object.keys(block)
			.filter((dependency) => dependency.startsWith(APP_SCOPE))
			.map(
				(dependency) => ({_tag: "Dependency", manifest, packageName, field, dependency}) as const,
			);
	});
};

/** Parse a manifest's text into the object `dependencyFindings` reads, or `null` when it is not one. */
export const parseManifest = (text: string): Record<string, unknown> | null => {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

export const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

/** Directories that hold build output, installed code or git state, not source anyone wrote. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"coverage",
	".turbo",
	".git",
]);

/** Where agent worktrees check out whole copies of this repo; each copy is another tree's source. */
export const WORKTREE_COPIES = ".claude/worktrees/";

/**
 * Whether a repo-relative path is source this guard reads: a source file outside `apps/`, outside
 * every skipped directory, and outside the worktree copies.
 */
export const inSourceScope = (path: string): boolean =>
	SOURCE_FILE.test(path) &&
	!isApp(path) &&
	!path.startsWith(WORKTREE_COPIES) &&
	!path.split("/").some((segment) => SKIPPED_DIRS.has(segment));

/**
 * The positions a module specifier takes: `from "x"` (static import and re-export), a bare
 * `import "x"`, `import("x")`, `require("x")`, and the vitest module doubles. Deliberately
 * over-inclusive over comments and strings — a false red costs a reword, a false green lets an app
 * import land. The one `\s*` before the optional `(` is the only unbounded run between the keyword
 * and the quote, so no two quantifiers can split the same whitespace.
 */
const IMPORT_SITE =
	/(?:\bfrom|\bimport|\brequire|\.(?:mock|doMock|importActual|importMock))\s*(?:\(\s*)?(["'`])([^"'`\s]*)\1/g;

const RELATIVE = /^\.\.?(?:\/|$)/;

/** The repo-relative path a relative specifier names from `file`, or `null` for any other specifier. */
export const resolveRelative = (file: string, specifier: string): string | null =>
	RELATIVE.test(specifier) ? posix.normalize(posix.join(posix.dirname(file), specifier)) : null;

const findingAt = (file: string, line: number, specifier: string): Finding | null => {
	if (specifier.startsWith(APP_SCOPE)) return {_tag: "Import", file, line, specifier};
	const resolved = resolveRelative(file, specifier);
	return resolved !== null && isApp(resolved)
		? {_tag: "PathImport", file, line, specifier, resolved}
		: null;
};

/**
 * Every import in a source text that reaches an app, with its 1-based line: an `@kampus-apps/*`
 * specifier, or a relative specifier that resolves under `apps/` from `file`.
 */
export const importFindings = (file: string, text: string): ReadonlyArray<Finding> =>
	[...text.matchAll(IMPORT_SITE)].flatMap((match) => {
		const finding = findingAt(file, text.slice(0, match.index).split("\n").length, match[2] ?? "");
		return finding === null ? [] : [finding];
	});

export interface ScanResult {
	/** Package manifests read outside `apps/`, the workspace root's included. */
	readonly packages: number;
	/** Source files read outside `apps/`, in members and at the root alike. */
	readonly files: number;
	readonly findings: ReadonlyArray<Finding>;
	/** Why a part of the scope could not be read. */
	readonly unread: ReadonlyArray<string>;
}

/**
 * The verdict over one scan. Zero packages or zero files is a scope that proves nothing, so it is
 * UNKNOWN rather than clean.
 */
export const judge = (scan: ScanResult): Verdict => {
	const findings = nonEmpty(scan.findings);
	if (findings !== null) return {_tag: "Violated", findings, unread: scan.unread};
	const reasons = nonEmpty([
		...scan.unread,
		...(scan.packages === 0 ? ["zero packages outside apps/ were scanned"] : []),
		...(scan.files === 0 ? ["zero source files outside apps/ were scanned"] : []),
	]);
	if (reasons !== null) return {_tag: "Unknown", reasons};
	return {_tag: "Clean", packages: scan.packages, files: scan.files};
};

const WHY = "an app is never imported (founder ruling on #9646)";

const findingLine = (finding: Finding): string => {
	switch (finding._tag) {
		case "Dependency":
			return `  ${finding.manifest}: ${finding.packageName} lists \`${finding.dependency}\` in ${finding.field} — ${WHY}. Fix: remove it, and move what the package needs out of the app into a package.`;
		case "Import":
			return `  ${finding.file}:${finding.line}: imports \`${finding.specifier}\` — ${WHY}. Fix: import it from a package instead.`;
		case "PathImport":
			return `  ${finding.file}:${finding.line}: imports \`${finding.specifier}\`, which resolves to ${finding.resolved} — ${WHY}. Fix: import it from a package instead.`;
	}
};

export const EXIT = {clean: 0, violated: 1, unknown: 2} as const;

/** The report a run prints, and the exit code it ends on. */
export const render = (verdict: Verdict): {readonly exitCode: number; readonly text: string} => {
	switch (verdict._tag) {
		case "Clean":
			return {
				exitCode: EXIT.clean,
				text: `app-boundary-guard: clean — ${verdict.packages} package manifests and ${verdict.files} source files outside apps/ name no ${APP_SCOPE}* package and no path under apps/.`,
			};
		case "Violated":
			return {
				exitCode: EXIT.violated,
				text: [
					`app-boundary-guard: ${verdict.findings.length} reference${verdict.findings.length === 1 ? "" : "s"} to an app from outside apps/:`,
					...verdict.findings.map(findingLine),
					...verdict.unread.map((reason) => `  also unread: ${reason}`),
				].join("\n"),
			};
		case "Unknown":
			return {
				exitCode: EXIT.unknown,
				text: [
					"app-boundary-guard: UNKNOWN — the scan could not prove the tree clean:",
					...verdict.reasons.map((reason) => `  ${reason}`),
				].join("\n"),
			};
	}
};
