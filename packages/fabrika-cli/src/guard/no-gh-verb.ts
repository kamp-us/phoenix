/**
 * `guard no-gh check` — no `gh` invocation is left under `packages/fabrika-cli/src/` (epic #6629).
 *
 * The verb owns the scope walk and its fail-closed floors, the way `./skill-lint-verb.ts` does: a
 * scan whose root resolved elsewhere, matched no file, or skipped a whole group directory is a
 * ZERO_SCOPE red rather than a green over nothing (ADR 0092, #5004). The matchers stay pure in
 * `./no-gh.ts`.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {isDirectory, type ReadFailed, readDir, readFile, realPath} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {atLine} from "./annotate.ts";
import {isZeroScope, type ScanFile, scanPackage} from "./no-gh.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard no-gh check";

/** The scanned tree: this package's own source, which is what the port made binary-free. */
const SOURCE = "packages/fabrika-cli/src";

const isSource = (name: string): boolean => name.endsWith(".ts");

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
			if (isSource(name)) found.push(relative);
		}
		return found.sort();
	});

/** The verb-group directories under `src/` — the coverage assertion below is keyed on them. */
const groupDirs = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const dirs: Array<string> = [];
		for (const name of yield* readDir(path.join(root, SOURCE))) {
			if (yield* isDirectory(path.join(root, SOURCE, name))) dirs.push(`${SOURCE}/${name}`);
		}
		return dirs.sort();
	});

/**
 * Group directories that contributed no scanned file.
 *
 * A walk narrowed to one corner still reports green over the corners it never entered, and a green
 * from an empty corner reads exactly like a green from clean code (#5004).
 */
const uncovered = (
	groups: ReadonlyArray<string>,
	files: ReadonlyArray<string>,
): ReadonlyArray<string> => groups.filter((dir) => !files.some((f) => f.startsWith(`${dir}/`)));

const judge = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const sourceReal = yield* realPath(path.join(root, SOURCE));
		const expected = path.join(yield* realPath(root), SOURCE);
		if (sourceReal !== expected) {
			return zeroScope(
				`${VERB}: the scan root ${SOURCE}/ resolves to ${sourceReal}, not ${expected} — the walk would scan another tree, or nothing. Fail-closed (ADR 0092).`,
			);
		}
		const files = yield* walk(root, SOURCE);
		if (files.length === 0) {
			return zeroScope(
				`${VERB}: the walk of ${SOURCE}/ matched ZERO .ts files — a guard that scanned nothing protects nothing. Fail-closed (ADR 0092).`,
			);
		}
		const missing = uncovered(yield* groupDirs(root), files);
		if (missing.length > 0) {
			return zeroScope(
				`${VERB}: these directories contributed ZERO scanned files, so the walk does not cover them: ${missing.join(", ")}. Fail-closed (ADR 0092; #5004).`,
			);
		}
		const corpus: Array<ScanFile> = [];
		for (const file of files) {
			corpus.push({file, content: yield* readFile(path.join(root, file))});
		}
		const result = scanPackage(corpus);
		if (isZeroScope(result)) {
			return zeroScope(
				`${VERB}: the scan saw zero of the ${files.length} file(s) walked — a check with no scope cannot go green. Fail-closed (ADR 0092).`,
			);
		}
		if (result.findings.length === 0) {
			return clean(
				`${VERB}: clean — ${result.scanned.length} file(s) under ${SOURCE}/ and no \`gh\` invocation among them`,
				result.scanned.length,
			);
		}
		return violation(
			[
				`${VERB}: ${result.findings.length} \`gh\` invocation(s) under ${SOURCE}/ — the package must reach GitHub over HTTP, so that a verb runs where no \`gh\` is installed (epic #6629, ADR 0315):`,
				...result.findings.map((f) => `  ${f.file}:${f.line}: ${f.matched} — ${f.reason}`),
			].join("\n"),
			annotationsOrNone(() =>
				result.findings.map((f) => atLine("error", f.file, f.line, f.reason)),
			),
		);
	});

export interface NoGhOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runNoGh = (
	options: NoGhOptions,
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
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the package was not fully scanned, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
