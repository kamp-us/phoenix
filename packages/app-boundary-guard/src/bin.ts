/**
 * `app-boundary-guard` bin — the IO shell around `./app-boundary.ts` that ci.yml's `app-boundary`
 * job runs (#9660, #9727). It judges the manifest of the root and of every workspace member outside
 * `apps/`, and reads every source file git lists outside `apps/`: member code and root-level code
 * such as `scripts/` or `.pnpmfile.cjs` alike.
 *
 * Zero runtime dependencies: the job runs this with checkout + setup-node + node and no install.
 *
 * Usage: `node src/bin.ts [--root <repo-root>]`. Exits 0 clean, 1 on a reference, 2 on UNKNOWN.
 */
import {spawnSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {
	dependencyFindings,
	type Finding,
	importFindings,
	inSourceScope,
	isApp,
	judge,
	parseManifest,
	parseWorkspaceGlobs,
	render,
	type WorkspaceGlob,
} from "./app-boundary.ts";

const rootFromArgs = (args: ReadonlyArray<string>): string => {
	const at = args.indexOf("--root");
	const given = at === -1 ? undefined : args[at + 1];
	return given === undefined
		? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
		: resolve(given);
};

const repoRoot = rootFromArgs(process.argv.slice(2));
const findings: Array<Finding> = [];
const unread: Array<string> = [];
let packages = 0;
let files = 0;

const rel = (path: string): string => relative(repoRoot, path).split("\\").join("/");

const readManifest = (manifestPath: string): void => {
	const parsed = parseManifest(readFileSync(manifestPath, "utf8"));
	if (parsed === null) {
		unread.push(`${rel(manifestPath)} does not parse as a JSON object`);
		return;
	}
	packages++;
	findings.push(...dependencyFindings(rel(manifestPath), parsed));
};

/**
 * Every file git tracks plus every untracked one it does not ignore, so a local run reads a new
 * file before it is staged and never reads ignored build output. `null` when git cannot answer,
 * which leaves the whole source scope unread.
 */
const listFiles = (): ReadonlyArray<string> | null => {
	const git = spawnSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
		{cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024},
	);
	if (git.error !== undefined || git.status !== 0) {
		const why = git.error?.message ?? (git.stderr.trim() || `exit ${git.status}`);
		unread.push(`git ls-files at ${repoRoot} failed: ${why}`);
		return null;
	}
	return git.stdout.split("\0").filter((path) => path !== "");
};

const readSources = (): void => {
	const listed = listFiles();
	if (listed === null) return;
	for (const path of listed.filter(inSourceScope)) {
		const full = join(repoRoot, path);
		// A tracked file deleted from the working tree has no text left to import anything.
		if (!existsSync(full)) continue;
		files++;
		findings.push(...importFindings(path, readFileSync(full, "utf8")));
	}
};

/** Member directories a glob names — only those that carry a `package.json`, as pnpm reads them. */
const expand = (globs: ReadonlyArray<WorkspaceGlob>): ReadonlyArray<string> =>
	globs.flatMap((entry) => {
		if (entry._tag === "Exact") return [entry.dir];
		const parent = join(repoRoot, entry.dir);
		if (!existsSync(parent)) return [];
		return readdirSync(parent, {withFileTypes: true})
			.filter((child) => child.isDirectory())
			.map((child) => `${entry.dir}/${child.name}`);
	});

const scan = (): void => {
	const workspace = join(repoRoot, "pnpm-workspace.yaml");
	if (!existsSync(workspace)) {
		unread.push(`no pnpm-workspace.yaml at ${repoRoot}`);
		return;
	}
	const globs = parseWorkspaceGlobs(readFileSync(workspace, "utf8"));
	if (globs._tag === "Unreadable") {
		unread.push(`pnpm-workspace.yaml: ${globs.reason}`);
		return;
	}
	const rootManifest = join(repoRoot, "package.json");
	if (existsSync(rootManifest)) readManifest(rootManifest);
	const members = [...new Set(expand(globs.globs))]
		.filter((dir) => !isApp(dir) && existsSync(join(repoRoot, dir, "package.json")))
		.sort();
	for (const member of members) readManifest(join(repoRoot, member, "package.json"));
	readSources();
};

try {
	scan();
} catch (error) {
	unread.push(`the scan threw: ${(error as Error).message}`);
}

const {exitCode, text} = render(judge({packages, files, findings, unread}));
(exitCode === 0 ? console.log : console.error)(text);
process.exit(exitCode);
