/**
 * The `codeql-lint` filesystem gate (issue #2261) — the IO seam behind the two
 * author-time CodeQL-shape checks, split from `command.ts` so the pure core is crossable
 * in unit tests over a fake repo dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom; #855).
 *
 * `checkCodeqlLint` is the pre-push / CI gate: it walks `.github/workflows/*.{yml,yaml}`
 * for permissions facts and the documented TS/JS source roots for regex literals, then
 * delegates the verdict to the pure core (`codeql-lint.ts`). It fails `CheckFailed`
 * (exit non-zero) on any workflow missing a least-privilege `permissions:` block or any
 * catastrophic-backtracking regex, or on zero scope (fail-closed, ADR 0092). A directory/
 * file IO failure is an `IoError` (also non-zero — both failures, undistinguished, per
 * the bin's contract).
 *
 * SCOPE (documented, no silent caps — skipped dirs are logged to stderr):
 *   - workflows: `.github/workflows/*.{yml,yaml}` (case-insensitive suffix).
 *   - source: `.ts/.tsx/.js/.jsx/.mjs/.cjs` under `apps/`, `packages/`, `infra/`,
 *     skipping `node_modules`, `dist`, `build`, `coverage`, `.git`, `tests`/`__tests__`
 *     dirs, and any `*.d.ts` / `*.test.*` / `*.spec.*` file. Test files are out of scope
 *     on purpose: ReDoS-on-uncontrolled-data is a runtime-path concern, and a test may
 *     legitimately carry an adversarial regex fixture (e.g. this tool's own tests).
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join, relative, sep} from "node:path";
import {Console, Data, Effect} from "effect";
import {
	type CodeqlLintBaseline,
	type CodeqlLintFacts,
	EMPTY_BASELINE,
	extractRegexes,
	judge,
	parseWorkflowFacts,
	type RegexLiteral,
	renderReport,
	type WorkflowFacts,
} from "./codeql-lint.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const WORKFLOWS_DIR = join(".github", "workflows");
const BASELINE_PATH = join(".github", "codeql-lint-baseline.json");
/** The TS/JS roots the regex scan descends (documented; skips logged, no silent caps). */
const SOURCE_ROOTS = ["apps", "packages", "infra"] as const;
const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"coverage",
	".git",
	"tests",
	"__tests__",
]);
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Repo-relative POSIX path — the key reports use. */
const toRel = (root: string, abs: string): string => relative(root, abs).split(sep).join("/");

const isWorkflowFile = (name: string): boolean => {
	const lower = name.toLowerCase();
	return lower.endsWith(".yml") || lower.endsWith(".yaml");
};

const isSourceFile = (name: string): boolean =>
	!name.endsWith(".d.ts") &&
	!/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) &&
	SOURCE_EXTS.some((ext) => name.endsWith(ext));

/** Gather every workflow file's permissions facts. Missing dir ⇒ no workflows (not an error). */
const gatherWorkflowFacts = (root: string): Effect.Effect<ReadonlyArray<WorkflowFacts>, IoError> =>
	Effect.try({
		try: () => {
			const dir = join(root, WORKFLOWS_DIR);
			if (!existsSync(dir)) return [];
			const out: Array<WorkflowFacts> = [];
			for (const entry of readdirSync(dir, {withFileTypes: true})) {
				if (!entry.isFile() || !isWorkflowFile(entry.name)) continue;
				const abs = join(dir, entry.name);
				out.push(parseWorkflowFacts(toRel(root, abs), readFileSync(abs, "utf8")));
			}
			return out;
		},
		catch: (cause) => new IoError({path: join(root, WORKFLOWS_DIR), cause}),
	});

/**
 * Walk a source root, collecting regex literals from every in-scope TS/JS file. Logs
 * each skipped directory name-class to stderr (no silent caps, ADR 0092) via `skipped`.
 */
const walkSource = (dir: string, root: string, acc: Array<RegexLiteral>): void => {
	for (const entry of readdirSync(dir, {withFileTypes: true})) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkSource(abs, root, acc);
		} else if (entry.isFile() && isSourceFile(entry.name)) {
			const path = toRel(root, abs);
			for (const r of extractRegexes(readFileSync(abs, "utf8"))) {
				acc.push({path, line: r.line, pattern: r.pattern});
			}
		}
	}
};

/**
 * Read the grandfather baseline (`.github/codeql-lint-baseline.json`). A MISSING file is
 * the empty baseline — strictest posture, nothing grandfathered (a fresh repo pins every
 * new workflow); a PRESENT-but-malformed file fails closed (a broken allow-list is a
 * broken scope assumption, not a vacuous pass — ADR 0092).
 */
const readBaseline = (root: string): Effect.Effect<CodeqlLintBaseline, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const path = join(root, BASELINE_PATH);
		if (!existsSync(path)) return EMPTY_BASELINE;
		const text = yield* Effect.try({
			try: () => readFileSync(path, "utf8"),
			catch: (cause) => new IoError({path, cause}),
		});
		const parsed = yield* Effect.try({
			try: () => JSON.parse(text) as Partial<CodeqlLintBaseline>,
			catch: (cause) => new IoError({path, cause}),
		});
		if (
			!Array.isArray(parsed.grandfatheredWorkflows) ||
			!Array.isArray(parsed.grandfatheredRegexes)
		) {
			return yield* Effect.fail(
				new CheckFailed({
					reason: `codeql-lint: ${BASELINE_PATH} is missing grandfatheredWorkflows / grandfatheredRegexes — the allow-list is broken, fail-closed (ADR 0092).`,
				}),
			);
		}
		return {
			grandfatheredWorkflows: parsed.grandfatheredWorkflows,
			grandfatheredRegexes: parsed.grandfatheredRegexes,
		};
	});

const gatherRegexes = (root: string): Effect.Effect<ReadonlyArray<RegexLiteral>, IoError> =>
	Effect.try({
		try: () => {
			const acc: Array<RegexLiteral> = [];
			for (const r of SOURCE_ROOTS) {
				const base = join(root, r);
				if (!existsSync(base)) continue;
				walkSource(base, root, acc);
			}
			return acc;
		},
		catch: (cause) => new IoError({path: root, cause}),
	});

/**
 * The pre-push / CI gate: succeed when every workflow pins least-privilege permissions
 * and no regex admits catastrophic backtracking, else `CheckFailed`. Fails closed on
 * zero scope (ADR 0092). The scanned scope (workflow + source-root skip set) is emitted
 * so "what did the gate look at" is answerable from the run log.
 */
export const checkCodeqlLint = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		yield* Console.error(
			`codeql-lint: scanning ${WORKFLOWS_DIR}/*.{yml,yaml} + ${SOURCE_ROOTS.join("/")} for *.{${SOURCE_EXTS.map((e) => e.slice(1)).join(",")}} (skipping ${[...SKIP_DIRS].join(", ")}, *.d.ts, *.test.*, *.spec.*).`,
		);
		const baseline = yield* readBaseline(root);
		const workflows = yield* gatherWorkflowFacts(root);
		const regexes = yield* gatherRegexes(root);
		const facts: CodeqlLintFacts = {workflows, regexes};
		const verdict = judge(facts, baseline);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
