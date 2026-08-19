/**
 * `guard skill-lint check` — the four mechanical gates over the plugin corpus (#743, #1766, #4213,
 * #4605), ported off v1's `gh-phoenix lint-skills` (epic #5720).
 *
 * **The scope walk moved into the verb.** In v1 it lived in `skill-gh-lint.yml` as forty lines of
 * bash — the physical-root resolution, the `find`, the zero-scope floor and the per-plugin coverage
 * assertion — and the CLI was handed a file list. That put four fail-closed decisions in a shell
 * step no unit test covers, and a local reproduction of a CI red meant retyping the `find`. Here the
 * verb owns them, so the workflow is one line and every refusal below is pinned by a test.
 *
 * The matchers themselves stay pure in `./skill-lint.ts`; this file is scope plus the verdict.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {isDirectory, type ReadFailed, readDir, readFile, realPath} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {type Annotation, atLine} from "./annotate.ts";
import {isZeroScope, type LintResult, lintCorpus, type ScanFile} from "./skill-lint.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard skill-lint check";

/** The corpus root: the whole plugin tree, every plugin dir, `skills/**` and `agents/**` alike. */
const CORPUS = "claude-plugins";

/** What an agent reads or runs. A `.sh` is scanned whole; a `.md` contributes its fenced blocks. */
const isCorpusFile = (name: string): boolean => name.endsWith(".md") || name.endsWith(".sh");

/** Every corpus file under `dir`, depth-first, as repo-relative paths. A failed read refuses. */
const walk = (
	root: string,
	dir: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const found: Array<string> = [];
		for (const name of yield* readDir(path.join(root, dir))) {
			const relative = path.join(dir, name);
			if (yield* isDirectory(path.join(root, relative))) {
				found.push(...(yield* walk(root, relative)));
				continue;
			}
			if (isCorpusFile(name)) found.push(relative);
		}
		return found.sort();
	});

/** The plugin directories the coverage assertion below is keyed on. */
const pluginDirs = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const dirs: Array<string> = [];
		for (const name of yield* readDir(path.join(root, CORPUS))) {
			if (yield* isDirectory(path.join(root, CORPUS, name))) dirs.push(`${CORPUS}/${name}`);
		}
		return dirs.sort();
	});

/**
 * Plugin dirs that contributed no scanned file.
 *
 * This is the assertion that makes a narrowed walk loud instead of silent: the job used to root at
 * one plugin dir, which excluded every sibling while still reporting green — and a green from an
 * empty corner is indistinguishable from a green from clean code (#5004).
 */
const uncovered = (
	plugins: ReadonlyArray<string>,
	files: ReadonlyArray<string>,
): ReadonlyArray<string> => plugins.filter((dir) => !files.some((f) => f.startsWith(`${dir}/`)));

/** Which of the four scopes came back empty — each one its own fail-closed floor (ADR 0092). */
const emptyScopes = (result: LintResult): ReadonlyArray<string> => {
	const empty: Array<string> = [];
	if (result.scanned.length === 0) empty.push("gh-call");
	if (result.frontmatterScanned.length === 0) empty.push("frontmatter");
	if (result.barePushScanned.length === 0) empty.push("bare-push");
	if (result.portabilityScanned.length === 0) empty.push("fence-portability");
	return empty;
};

interface Section {
	readonly head: string;
	readonly lines: ReadonlyArray<string>;
	readonly annotations: ReadonlyArray<Annotation>;
}

const located = (findings: LintResult["findings"], head: string): Section => ({
	head,
	lines: findings.map((f) => `  ${f.file}:${f.line}: ${f.matched} — ${f.reason}`),
	annotations: findings.map((f) => atLine("error", f.file, f.line, f.reason)),
});

/** The report a red prints, one section per check that found something. */
const findingReport = (result: LintResult): Section => {
	const sections: Array<Section> = [];
	if (result.findings.length > 0) {
		sections.push(
			located(
				result.findings,
				`${result.findings.length} GraphQL-path gh call(s) — REST only on this org (#743):`,
			),
		);
	}
	if (result.frontmatterFindings.length > 0) {
		sections.push({
			head: `${result.frontmatterFindings.length} file(s) with invalid YAML frontmatter — a mid-sentence colon-space in an unquoted scalar reparses as a mapping; quote the value or use a block scalar (#1766):`,
			lines: result.frontmatterFindings.map((f) => `  ${f.file}: ${f.reason}`),
			annotations: result.frontmatterFindings.map((f) => atLine("error", f.file, 1, f.reason)),
		});
	}
	if (result.barePushFindings.length > 0) {
		sections.push(
			located(
				result.barePushFindings,
				`${result.barePushFindings.length} bare \`git push\` invocation(s) in a runnable block — the sanctioned path is \`fabrika build push\` (#4213):`,
			),
		);
	}
	if (result.portabilityFindings.length > 0) {
		sections.push(
			located(
				result.portabilityFindings,
				`${result.portabilityFindings.length} non-portable plugin path literal(s) in a fence — a consumer installs the plugin outside their repo, so \`./claude-plugins/…\` cannot resolve there; use \`./.claude/.pipeline/…\` (#4605):`,
			),
		);
	}
	return {
		head: `${VERB}: FAIL`,
		lines: sections.flatMap((s) => [`${VERB}: ${s.head}`, ...s.lines]),
		annotations: sections.flatMap((s) => s.annotations),
	};
};

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		// `readDirectory` follows a symlinked root, but a corpus that physically lives elsewhere is
		// not the tree this repo's gates judge — and a `..`-folding logical path has produced a false
		// pass here before. Resolve both sides and compare.
		const corpusReal = yield* realPath(path.join(root, CORPUS));
		const expected = path.join(yield* realPath(root), CORPUS);
		if (corpusReal !== expected) {
			return zeroScope(
				`${VERB}: the scan root ${CORPUS}/ resolves to ${corpusReal}, not ${expected} — the walk would scan another tree, or nothing. Fail-closed (ADR 0092).`,
			);
		}
		const files = yield* walk(root, CORPUS);
		if (files.length === 0) {
			return zeroScope(
				`${VERB}: the walk of ${CORPUS}/ matched ZERO .md/.sh files — a lint that scanned nothing protects nothing. Fail-closed (ADR 0092).`,
			);
		}
		const missing = uncovered(yield* pluginDirs(root), files);
		if (missing.length > 0) {
			return zeroScope(
				`${VERB}: these plugin dirs contributed ZERO scanned files, so the walk does not cover them: ${missing.join(", ")}. Fail-closed (ADR 0092; #5004).`,
			);
		}
		const corpus: Array<ScanFile> = [];
		for (const file of files) {
			corpus.push({file, content: yield* readFile(path.join(root, file))});
		}
		const result = lintCorpus(corpus);
		if (isZeroScope(result)) {
			return zeroScope(
				`${VERB}: ${emptyScopes(result).join(", ")} scan(s) saw zero files of ${files.length} walked — a check with no scope cannot go green. Fail-closed (ADR 0092).`,
			);
		}
		const total =
			result.findings.length +
			result.frontmatterFindings.length +
			result.barePushFindings.length +
			result.portabilityFindings.length;
		if (total === 0) {
			return clean(
				`${VERB}: clean — ${files.length} file(s) under ${CORPUS}/: no GraphQL-path gh call, no bare \`git push\` in a runnable block, no non-portable plugin path literal in a fence, and every frontmatter block parses as strict YAML`,
				files.length,
			);
		}
		const report = findingReport(result);
		return violation(
			report.lines.join("\n"),
			annotationsOrNone(() => report.annotations),
		);
	});

export interface SkillLintOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runSkillLint = (
	options: SkillLintOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judge(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the corpus was not fully scanned, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
