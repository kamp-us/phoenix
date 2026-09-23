/**
 * `app-boundary-guard` bin — the IO shell around `./app-boundary.ts` that ci.yml's `app-boundary`
 * job runs (#9660). It reads the workspace members off `pnpm-workspace.yaml`, drops those under
 * `apps/`, and hands every remaining manifest and source text to the core.
 *
 * Zero runtime dependencies: the job runs this with checkout + setup-node + node and no install.
 *
 * Usage: `node src/bin.ts [--root <repo-root>]`. Exits 0 clean, 1 on a reference, 2 on UNKNOWN.
 */
import {type Dirent, existsSync, readdirSync, readFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {
	dependencyFindings,
	type Finding,
	importFindings,
	isApp,
	judge,
	parseManifest,
	parseWorkspaceGlobs,
	render,
	SOURCE_FILE,
	type WorkspaceGlob,
} from "./app-boundary.ts";

/** Build output and installed code: not what the package's author wrote. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"coverage",
	".turbo",
	".git",
]);

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

const walkSources = (dir: string): void => {
	let entries: Array<Dirent>;
	try {
		entries = readdirSync(dir, {withFileTypes: true, encoding: "utf8"});
	} catch (error) {
		unread.push(`${rel(dir)}: ${(error as Error).message}`);
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) walkSources(full);
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			files++;
			findings.push(...importFindings(rel(full), readFileSync(full, "utf8")));
		}
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
	// The root is a workspace package too; its manifest is judged, but its tree is every member's.
	const rootManifest = join(repoRoot, "package.json");
	if (existsSync(rootManifest)) readManifest(rootManifest);
	const members = [...new Set(expand(globs.globs))]
		.filter((dir) => !isApp(dir) && existsSync(join(repoRoot, dir, "package.json")))
		.sort();
	for (const member of members) {
		readManifest(join(repoRoot, member, "package.json"));
		walkSources(join(repoRoot, member));
	}
};

try {
	scan();
} catch (error) {
	unread.push(`the scan threw: ${(error as Error).message}`);
}

const {exitCode, text} = render(judge({packages, files, findings, unread}));
(exitCode === 0 ? console.log : console.error)(text);
process.exit(exitCode);
