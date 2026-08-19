/**
 * `worker-relevance` classify bin — the IO shell around the pure core, run by
 * ci.yml's `changes` job (issue #1014, ADR 0114). Exits 0 always: a classifier,
 * not a gate.
 *
 * ZERO runtime dependencies on purpose: the `changes` job runs this with only
 * checkout + setup-node + node — no `pnpm install`, hence plain Node, no Effect.
 *
 * FAIL-SAFE TO RUNNING (ADR 0114): a scan that THROWS must not silently yield an
 * empty closure and skip a test-consumed package, so any scan error
 * short-circuits to `worker_relevant=true`.
 */
import {appendFileSync, type Dirent, readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {classify, extractKampusPackages, inputFromEnv} from "./worker-relevance.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TEST_TREES = ["apps/web/tests/integration", "apps/web/tests/e2e"] as const;

const SOURCE_EXT = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

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
 * The test-import closure (ADR 0114). A specifier resolving to no `packages/<name>`
 * dir (an app-level alias, a non-package scope member) is dropped, so the closure
 * is exactly the test-consumed `packages/**` members.
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
