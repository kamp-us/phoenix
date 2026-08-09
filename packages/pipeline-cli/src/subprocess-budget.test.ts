/**
 * The subprocess test tier stays complete across the WHOLE workspace: every test file in a guarded
 * workspace member that spawns a real child process runs its suites under a named
 * `SUBPROCESS_TEST_TIMEOUT_MS`, never vitest's 5s default (#4014).
 *
 * This guard used to root its scan at its own package directory, so it enforced the tier inside
 * `packages/pipeline-cli/` and reported nothing about anywhere else — it ran, it passed, and it had
 * never looked (#4858). A guard that passes because its scope is empty is indistinguishable from one
 * that passes because the code is clean, so the scope is now DERIVED from the declared workspace
 * members and the scan fails closed on an empty or collapsed one (ADR 0092).
 */
import {existsSync, readdirSync, readFileSync, realpathSync, statSync} from "node:fs";
import {dirname, join, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";
import {parseWorkspacePackageGlobs} from "./tools/publish-isolation-guard/publish-isolation-guard.ts";

/**
 * The workspace roots this guard covers, mirroring what the `packages unit tests` job actually runs
 * (`pnpm --filter './packages/**' --filter @kampus/infra run test` in `.github/workflows/ci.yml`) —
 * that job is the blocking route, via `ci-required`'s `needs:`, so guarding a member the job never
 * runs would be an assertion with no teeth. `apps/*` is out of tier by construction, not by
 * omission: `apps/web/vitest.config.ts` sets a project-level `testTimeout` on the only project whose
 * tests spawn.
 */
const GUARDED_WORKSPACE_ROOTS = ["packages", "infra"] as const;

/** Physical resolution — the `.claude/skills` symlink's `..` folding can otherwise walk past the root. */
const repoRoot = (): string => {
	let dir = realpathSync(dirname(fileURLToPath(import.meta.url)));
	for (;;) {
		if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
		const up = dirname(dir);
		if (up === dir) throw new Error("subprocess-budget: no pnpm-workspace.yaml above this file");
		dir = up;
	}
};

const ROOT = repoRoot();

/** `packages/*` → every child dir of `packages/` carrying a `package.json`. */
const membersUnder = (glob: string): readonly string[] => {
	const m = /^(.+)\/\*$/.exec(glob);
	if (m?.[1] === undefined) return existsSync(join(ROOT, glob, "package.json")) ? [glob] : [];
	const parent = m[1];
	const abs = join(ROOT, parent);
	if (!existsSync(abs)) return [];
	return readdirSync(abs)
		.map((name) => `${parent}/${name}`)
		.filter((rel) => existsSync(join(ROOT, rel, "package.json")));
};

interface Scope {
	readonly members: readonly string[];
	/** Per guarded root, the members it contributed — an empty list is a scope regression, not a pass. */
	readonly byRoot: ReadonlyMap<string, readonly string[]>;
}

const workspaceScope = (): Scope => {
	const globs = parseWorkspacePackageGlobs(readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8"));
	const byRoot = new Map<string, readonly string[]>();
	for (const root of GUARDED_WORKSPACE_ROOTS) {
		const hits = globs.filter((g) => g === root || g.startsWith(`${root}/`)).flatMap(membersUnder);
		byRoot.set(root, hits);
	}
	return {members: [...byRoot.values()].flat().sort(), byRoot};
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

const testFilesIn = (memberRel: string): readonly string[] => {
	const out: string[] = [];
	const walk = (rel: string): void => {
		const abs = join(ROOT, rel);
		for (const entry of readdirSync(abs, {withFileTypes: true})) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(join(rel, entry.name));
			} else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
				out.push(join(rel, entry.name));
			}
		}
	};
	if (statSync(join(ROOT, memberRel)).isDirectory()) walk(memberRel);
	return out;
};

/**
 * A file that IMPORTS `node:child_process` spawns for real — that import statement is the tier
 * membership, matched as a statement rather than as a bare substring so this scanner (which names
 * the module in its own source) doesn't scan itself.
 */
const CHILD_PROCESS_IMPORT = /^import\s[^;]*\sfrom\s"node:child_process";$/m;

const spawningTestFiles = (): ReadonlyArray<readonly [string, string]> =>
	workspaceScope()
		.members.flatMap(testFilesIn)
		.map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")] as const)
		.filter(([, src]) => CHILD_PROCESS_IMPORT.test(src));

const packageOf = (rel: string): string => rel.split(sep).slice(0, 2).join("/");

/**
 * Each `describe(` head, sliced up to its factory arrow — the window the `{timeout}` option must
 * sit in. Syntactic on purpose: the assertion is about the option being written at the suite, and
 * a suite-level option is what covers every `it` in the file, including ones added later.
 */
const describeHeads = (src: string): readonly string[] => {
	const heads: string[] = [];
	const re = /\bdescribe(?:\.\w+)?\s*\(/g;
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		const arrow = src.indexOf("=>", m.index);
		heads.push(src.slice(m.index, arrow === -1 ? src.length : arrow));
	}
	return heads;
};

const DECLARES_BUDGET = /^\s*(?:export\s+)?const\s+SUBPROCESS_TEST_TIMEOUT_MS\s*=\s*([0-9_]+)/m;

/** Every `src/test-budget.ts` in scope — the one place per package the number may be written. */
const budgetModules = (): ReadonlyArray<readonly [string, string]> =>
	workspaceScope()
		.members.map((m) => join(m, "src", "test-budget.ts"))
		.filter((rel) => existsSync(join(ROOT, rel)))
		.map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")] as const);

describe("every subprocess-spawning test suite carries the subprocess timeout budget (#4014, #4858)", () => {
	it("derives a non-empty workspace scope, and every guarded root contributes (ADR 0092)", () => {
		const {members, byRoot} = workspaceScope();
		expect(members.length).toBeGreaterThan(0);
		expect([...byRoot].filter(([, hits]) => hits.length === 0).map(([root]) => root)).toEqual([]);
	});

	it("finds subprocess-spawning test files at all — fail closed on zero scope (ADR 0092)", () => {
		expect(spawningTestFiles().map(([rel]) => rel).length).toBeGreaterThan(0);
	});

	/**
	 * The #4858 regression detector. Re-narrowing the scan root to one package leaves every other
	 * assertion here green — the tier is complete *within* pipeline-cli — so "the tier spans more
	 * than one workspace member" is the property that has to be asserted directly.
	 */
	it("scans beyond its own package — a scope collapsed back to one member reds (#4858)", () => {
		const packages = new Set(spawningTestFiles().map(([rel]) => packageOf(rel)));
		expect([...packages].sort().length).toBeGreaterThan(1);
	});

	it("declares a `{timeout: SUBPROCESS_TEST_TIMEOUT_MS}` on every describe in every such file", () => {
		const offenders = spawningTestFiles().flatMap(([rel, src]) => {
			const heads = describeHeads(src);
			if (heads.length === 0) return [`${rel}: spawns a subprocess but declares no describe suite`];
			return heads
				.filter((head) => !head.includes("SUBPROCESS_TEST_TIMEOUT_MS"))
				.map((head) => `${rel}: ${head.split("\n")[0]?.trim()}`);
		});
		expect(offenders).toEqual([]);
	});

	/**
	 * A trailing `}, 30_000)` on an `it` overrides the suite budget, usually downward, which is how
	 * the tier scattered its number in the first place (`.patterns/subprocess-test-budget.md`). The
	 * shape is what identifies it — a numeric argument following the callback's closing brace, which
	 * biome always puts at the start of a line — so neither a number inside a fixture object nor a
	 * `setInterval(() => {}, 1000)` in a spawned child's inline source is mistaken for a ceiling.
	 */
	it("writes no per-test timeout literal — the suite budget is the only ceiling", () => {
		const offenders = spawningTestFiles().flatMap(([rel, src]) =>
			(src.match(/^[\t ]*\},\s*\d[\d_]*\s*,?\s*\)/gm) ?? []).map(
				(hit) => `${rel}: ${hit.replace(/\s+/g, " ")}`,
			),
		);
		expect(offenders).toEqual([]);
	});

	it("imports the budget instead of re-declaring it — no per-file copies of the number", () => {
		const offenders = spawningTestFiles()
			.filter(([, src]) => DECLARES_BUDGET.test(src))
			.map(
				([rel]) =>
					`${rel}: declares SUBPROCESS_TEST_TIMEOUT_MS locally; import it from test-budget.ts`,
			);
		expect(offenders).toEqual([]);
	});

	it("keeps every package's test-budget.ts on the one canonical ceiling", () => {
		const modules = budgetModules();
		expect(modules.map(([rel]) => rel).length).toBeGreaterThan(0);
		const offenders = modules
			.map(([rel, src]) => [rel, DECLARES_BUDGET.exec(src)?.[1]?.replace(/_/g, "")] as const)
			.filter(([, value]) => value !== String(SUBPROCESS_TEST_TIMEOUT_MS))
			.map(([rel, value]) => `${rel}: exports ${value ?? "no SUBPROCESS_TEST_TIMEOUT_MS"}`);
		expect(offenders).toEqual([]);
	});
});
