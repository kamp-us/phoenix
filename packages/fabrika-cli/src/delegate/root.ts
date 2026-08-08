/**
 * Where the repo containing the cwd starts.
 *
 * This exists so the delegation can tell *"I am not in a repo"* apart from *"I am in a repo that
 * pins `@kampus/fabrika-cli` but has not installed it"*. Collapsing those two into one branch is what makes a
 * delegation quietly wrong: the second case silently runs the global, which is the outcome #4784
 * exists to prevent. Only one of them is allowed to be silent, and it is the first.
 *
 * The rule is turbo's (`crates/turborepo-shim/`, `main` @ `c6fbc97`): collect **every** ancestor
 * holding a `package.json` — never stop at the first — then prefer the **highest** one whose
 * workspace globs actually match the closest package. `package.json` only; no lockfile, no marker
 * file. No root found is not an error.
 */
import {Effect, type FileSystem, Path} from "effect";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";

/** An ancestor that holds a `package.json`, with whatever workspace globs that manifest declares. */
export interface PackageDir {
	readonly dir: string;
	readonly globs: ReadonlyArray<string>;
}

/**
 * `from` and every ancestor up to the filesystem root, nearest first.
 *
 * Nearest-first is the ordering every caller below relies on: index 0 is the closest package.
 */
export const ancestors = (path: Path.Path, from: string): ReadonlyArray<string> => {
	const walked: string[] = [];
	let current = path.resolve(from);
	for (;;) {
		walked.push(current);
		const parent = path.dirname(current);
		if (parent === current) return walked;
		current = parent;
	}
};

const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * A single workspace glob as an anchored regex over a `/`-joined relative path.
 *
 * `**` is any number of segments, `*` is one segment's worth of characters, `?` is one character —
 * the subset pnpm and npm workspace globs actually use. Anything else is matched literally.
 */
export const globToRegExp = (glob: string): RegExp => {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i] as string;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
			continue;
		}
		out += ch === "?" ? "[^/]" : ch.replace(GLOB_SPECIALS, "\\$&");
	}
	return new RegExp(`^${out}$`);
};

/** Whether `relPath` is inside the workspace `globs` declare, honouring `!` exclusions. */
export const matchesWorkspaceGlobs = (globs: ReadonlyArray<string>, relPath: string): boolean => {
	if (relPath === "" || relPath.startsWith("..")) return false;
	let included = false;
	for (const glob of globs) {
		const negated = glob.startsWith("!");
		const body = negated ? glob.slice(1) : glob;
		if (!globToRegExp(body).test(relPath)) continue;
		if (negated) return false;
		included = true;
	}
	return included;
};

/**
 * The `packages:` list out of a `pnpm-workspace.yaml`.
 *
 * Hand-read rather than parsed with a YAML dependency: the CLI's whole bootstrap runs before any
 * dependency is guaranteed linked, so the delegation deliberately imports nothing beyond the
 * platform seam. The shape read is the one the file format prescribes — a top-level `packages:` key
 * followed by indented `- <glob>` items, terminated by the next top-level key.
 */
export const pnpmWorkspaceGlobs = (yaml: string): ReadonlyArray<string> => {
	const globs: string[] = [];
	let inPackages = false;
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/#.*$/, "").trimEnd();
		if (line.trim() === "") continue;
		if (!/^\s/.test(line)) {
			inPackages = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inPackages) continue;
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item === null) continue;
		globs.push((item[1] as string).trim().replace(/^["']|["']$/g, ""));
	}
	return globs;
};

/** The `workspaces` field of a `package.json`, in either the array or the `{packages}` shape. */
export const manifestWorkspaceGlobs = (manifestText: string): ReadonlyArray<string> => {
	// A manifest that will not parse declares no workspace. It still counts as a package dir —
	// turbo's search is for the FILE, and a root whose manifest is broken is a repo root whose local
	// install probe reports corrupt downstream, not a reason to keep walking.
	const manifest = parseJson(manifestText);
	if (!isRecord(manifest)) return [];
	const workspaces = manifest.workspaces;
	const list = Array.isArray(workspaces)
		? workspaces
		: isRecord(workspaces)
			? workspaces.packages
			: undefined;
	return Array.isArray(list) ? list.filter((g): g is string => typeof g === "string") : [];
};

/**
 * The repo root among `candidates` (nearest first), or `undefined` when there are none.
 *
 * Pure, so the preference rule is testable without a filesystem: the **highest** candidate whose
 * globs match the closest package wins; absent any such candidate the closest package is the root.
 */
export const chooseRoot = (
	path: Path.Path,
	candidates: ReadonlyArray<PackageDir>,
): string | undefined => {
	const closest = candidates[0];
	if (closest === undefined) return undefined;
	for (let i = candidates.length - 1; i >= 1; i--) {
		const candidate = candidates[i] as PackageDir;
		const rel = path.relative(candidate.dir, closest.dir).split(path.sep).join("/");
		if (matchesWorkspaceGlobs(candidate.globs, rel)) return candidate.dir;
	}
	return closest.dir;
};

/**
 * The repo root at or above `from`, or `undefined` when the cwd is in no repo at all.
 *
 * `undefined` is a **proven** absence — every ancestor was probed. A probe that could not be
 * performed leaves on the `E` channel instead, because an unreadable ancestor answered as "no repo"
 * would downgrade a pinned repo to the global without saying so.
 */
export const discoverRepoRoot = (
	from: string,
): Effect.Effect<string | undefined, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const candidates: PackageDir[] = [];
		for (const dir of ancestors(path, from)) {
			const manifestPath = path.join(dir, "package.json");
			if (!(yield* exists(manifestPath))) continue;
			const pnpmPath = path.join(dir, "pnpm-workspace.yaml");
			const globs = (yield* exists(pnpmPath))
				? pnpmWorkspaceGlobs(yield* readFile(pnpmPath))
				: manifestWorkspaceGlobs(yield* readFile(manifestPath));
			candidates.push({dir, globs});
		}
		return chooseRoot(path, candidates);
	});

/**
 * Where the *running* copy lives — the second root the delegation has to know about.
 *
 * A tagged union rather than `string | undefined` on purpose: `undefined` would be readable as "not
 * looked up", and never looking it up is exactly the defect (#4956). This type has no state that
 * means "undecided", so a caller either has an answer or is holding an `Effect` that failed.
 */
export type SelfOrigin =
	| {readonly _tag: "no-checkout"}
	| {readonly _tag: "checkout"; readonly root: string};

const NODE_MODULES = "node_modules";

/**
 * The checkout the copy at `packageRoot` belongs to, or `no-checkout` for an installed artifact.
 *
 * Two narrowings against {@link discoverRepoRoot} keep the designed global-install delegation intact,
 * and both are load-bearing rather than defensive. The walk starts at the package root's **parent**,
 * because a package root always holds its own `package.json` and would otherwise be its own repo
 * root. And a path with a `node_modules` segment answers `no-checkout` outright, because an installed
 * copy is an artifact of some tree, not a checkout of one — `pnpm add --global` writes a
 * `package.json` beside the global `node_modules`, so a plain ancestor walk would report every global
 * install as a checkout and turn the one branch that is *meant* to delegate into a refusal.
 */
export const originOf = (
	packageRoot: string,
): Effect.Effect<SelfOrigin, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const resolved = path.resolve(packageRoot);
		if (resolved.split(path.sep).includes(NODE_MODULES)) return {_tag: "no-checkout"} as const;
		const parent = path.dirname(resolved);
		if (parent === resolved) return {_tag: "no-checkout"} as const;
		const root = yield* discoverRepoRoot(parent);
		return root === undefined
			? ({_tag: "no-checkout"} as const)
			: ({_tag: "checkout", root} as const);
	});
