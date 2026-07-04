/**
 * `worker-relevance` classify bin — the CI-callable surface for issue #1014, extended
 * with the test-import closure of ADR 0114.
 *
 * Reads the PR's changed-file list + the lockfile diff from `process.env` (set by the
 * `changes` job's classify step in ci.yml), COMPUTES the test-import closure by
 * scanning the real imports under the integration/e2e test trees, runs the pure
 * `classify` core over the union of the worker-import and test-import closures, emits
 * the verdict to the log (ADR 0092 §1 "emit what you scanned"), and writes a
 * `worker_relevant=true|false` line to `$GITHUB_OUTPUT` so the job's
 * `integration_required`/`e2e_required` expressions can AND it in. Exits 0 always —
 * this is a classifier, not a gate; the workflow decides what to do with the verdict.
 *
 * ZERO runtime dependencies on purpose (the `@kampus/ci-required` idiom): the
 * `changes` job runs this with only checkout + setup-node + node — no `pnpm install`
 * — so the always-on changed-area detector stays fast. Plain Node (no Effect import)
 * for the same reason. The pure core (`classify` + `inputFromEnv` + the import
 * extractor) is the unit-tested module; this bin is the IO shell — walk the test
 * trees, read env, print, write output.
 *
 * FAIL-SAFE TO RUNNING (ADR 0114): the closure is computed from real imports so it
 * cannot drift, but a scan that THROWS (a tree became unreadable, a resolution error)
 * must not silently yield an empty closure and skip a test-consumed package. On any
 * scan error the bin short-circuits to `worker_relevant=true` — running is the safe
 * verdict when the test-import closure can't be proven.
 */
import {appendFileSync, type Dirent, readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {classify, extractKampusPackages, inputFromEnv} from "./worker-relevance.ts";

/** Repo root, derived from this file's location (`packages/worker-relevance/src/bin.ts`). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The integration/e2e test trees whose real imports form the test-import closure (ADR 0114). */
const TEST_TREES = ["apps/web/tests/integration", "apps/web/tests/e2e"] as const;

/** Extensions the import scanner reads — the TS/JS source shapes a test tree carries. */
const SOURCE_EXT = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

/** Recursively collect source-file paths under `dir`; a missing tree yields none. */
const walkSourceFiles = (dir: string): string[] => {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, {withFileTypes: true, encoding: "utf8"});
	} catch (err) {
		// A MISSING tree is fine (a repo may have no e2e tree) → no files. Any OTHER
		// read error (permissions, IO) is a scan failure the caller must fail-safe on.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkSourceFiles(full));
		else if (entry.isFile() && SOURCE_EXT.test(entry.name)) files.push(full);
	}
	return files;
};

/** Does `packages/<name>` exist as a workspace package named `@kampus/<name>`? */
const isWorkspacePackage = (name: string): boolean => {
	try {
		const pkg = readFileSync(join(REPO_ROOT, "packages", name, "package.json"), "utf8");
		return (JSON.parse(pkg) as {name?: string}).name === `@kampus/${name}`;
	} catch (err) {
		// No such package dir → not a `packages/**` member (correctly excluded). A
		// non-ENOENT read/parse error is a scan failure the caller must fail-safe on.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
};

/**
 * The test-import closure: `packages/<name>` dir-names imported under the two test
 * trees, computed from real imports (ADR 0114). Each `@kampus/<name>` specifier is
 * resolved to a `packages/**` member by confirming `packages/<name>` is a real
 * workspace package; a specifier that resolves to no such dir (an app-level alias, a
 * non-package scope member) is dropped, so the closure is exactly the set of
 * test-consumed `packages/**` members.
 */
const computeTestImportedPackages = (): ReadonlySet<string> => {
	const candidates = new Set<string>();
	for (const tree of TEST_TREES) {
		for (const file of walkSourceFiles(join(REPO_ROOT, tree))) {
			for (const name of extractKampusPackages(readFileSync(file, "utf8"))) {
				candidates.add(name);
			}
		}
	}
	const members = new Set<string>();
	for (const name of candidates) {
		if (isWorkspacePackage(name)) members.add(name);
	}
	return members;
};

const emit = (workerRelevant: boolean): void => {
	const output = process.env.GITHUB_OUTPUT;
	if (output !== undefined && output !== "") {
		appendFileSync(output, `worker_relevant=${workerRelevant}\n`);
	} else {
		// No $GITHUB_OUTPUT (local run) — print the line the workflow would have consumed.
		console.log(`worker_relevant=${workerRelevant}`);
	}
};

let testImportedPackages: ReadonlySet<string>;
try {
	testImportedPackages = computeTestImportedPackages();
} catch (err) {
	// Scan failure ⇒ the test-import closure is unprovable ⇒ fail SAFE to running (ADR 0114).
	console.log(
		`relevant — test-import closure scan failed (${(err as Error).message}); fail-safe to running (ADR 0114)`,
	);
	emit(true);
	process.exit(0);
}

console.log(`test-import closure (ADR 0114): {${[...testImportedPackages].sort().join(", ")}}`);

const verdict = classify({...inputFromEnv(process.env), testImportedPackages});
console.log(verdict.reason);
emit(verdict.verdict === "relevant");
