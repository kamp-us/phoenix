/**
 * `guard i18n-guard check` — the IO boundary for #7536's rule.
 *
 * Walk `apps/web/src` for TS/TSX, drop what the scope rule exempts, hand each file's source to the
 * pure scanner in `./i18n-literal.ts` along with the committed allow-list, and seat the answer on
 * the group's exit taxonomy.
 */

import {Effect, FileSystem, Option, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {type ReadFailed, readDir, readFile} from "../io/fs.ts";
import {parseJson} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	type Allowance,
	annotationsFor,
	type FileScan,
	type I18nGuardConfig,
	isInScope,
	judge,
	renderReport,
	SCAN_ROOT,
	scanSource,
} from "./i18n-literal.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard i18n-guard check";

const CONFIG_PATH = "apps/web/src/i18n/i18n-guard.config.json";

export interface I18nGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Every file under `base`, skipping `node_modules`/`dist` and not following symlinked directories.
 *
 * A directory that cannot be listed fails the walk rather than being swallowed: a swallowed
 * directory shrinks the corpus while `judge` still sees files elsewhere and passes, which is a clean
 * verdict over a scan that silently narrowed (ADR 0092).
 */
const walk = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	base: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const found: Array<string> = [];
		const stack = [base];
		for (;;) {
			const dir = stack.pop();
			if (dir === undefined) break;
			for (const name of yield* readDir(dir)) {
				const abs = path.join(dir, name);
				const stat = yield* Effect.option(fs.stat(abs));
				if (Option.isNone(stat)) {
					found.push(abs);
					continue;
				}
				if (stat.value.type === "Directory") {
					if (name === "node_modules" || name === "dist") continue;
					if (yield* Effect.isSuccess(fs.readLink(abs))) continue;
					stack.push(abs);
				} else {
					found.push(abs);
				}
			}
		}
		return found;
	});

/** Repo-relative POSIX path — the key an allowance is written against. */
const toRel = (path: Path.Path, root: string, abs: string): string =>
	path.relative(root, abs).split(path.sep).join("/");

const gather = (
	root: string,
): Effect.Effect<ReadonlyArray<FileScan>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const files = yield* walk(fs, path, path.join(root, SCAN_ROOT));
		const scans: Array<FileScan> = [];
		for (const abs of files) {
			const rel = toRel(path, root, abs);
			if (!isInScope(rel)) continue;
			scans.push({path: rel, hits: scanSource(yield* readFile(abs))});
		}
		return scans.sort((a, b) => a.path.localeCompare(b.path));
	});

/** The parsed allow-list, or the named reason it is unusable. */
type ConfigRead =
	| {readonly _tag: "Config"; readonly config: I18nGuardConfig}
	| {readonly _tag: "Malformed"; readonly report: string};

const isAllowanceMap = (value: unknown): value is Readonly<Record<string, Allowance>> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value as Record<string, unknown>).every(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			typeof (entry as Allowance).ceiling === "number" &&
			typeof (entry as Allowance).why === "string" &&
			(entry as Allowance).why.trim().length > 0,
	);
};

const readConfig = (
	root: string,
): Effect.Effect<ConfigRead, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const parsed = parseJson(yield* readFile(path.join(root, CONFIG_PATH))) as Partial<
			Record<"exempt" | "unmigrated", unknown>
		> | null;
		if (parsed === null || !isAllowanceMap(parsed.exempt) || !isAllowanceMap(parsed.unmigrated)) {
			return {
				_tag: "Malformed",
				report: `${VERB}: ${CONFIG_PATH} does not parse, or an entry under exempt/unmigrated is missing a numeric \`ceiling\` or a non-empty \`why\` — the allow-list the ratchet is judged against is broken, fail-closed (ADR 0092).\n`,
			};
		}
		return {_tag: "Config", config: {exempt: parsed.exempt, unmigrated: parsed.unmigrated}};
	});

const judgeTree = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const config = yield* readConfig(root);
		if (config._tag === "Malformed") return zeroScope(config.report);
		const verdict = judge({files: yield* gather(root), config: config.config});
		const report = renderReport(verdict);
		if (verdict._tag === "Clean") return clean(report, verdict.filesScanned);
		if (verdict._tag === "ZeroScope") return zeroScope(report);
		return violation(
			report,
			annotationsOrNone(() => annotationsFor(verdict)),
		);
	});

export const runI18nGuard = (
	options: I18nGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const root =
			options.root ?? (yield* discoverRepoRoot(options.cwd).pipe(Effect.map((r) => r ?? null)));
		if (root === null) {
			return emitVerdict(
				unknown(
					`${VERB}: no repo root at or above ${options.cwd} — nothing to scope the scan to, so the verdict is UNKNOWN.\n`,
				),
				options.env,
			);
		}
		return emitVerdict(yield* judgeTree(root), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.\n`,
					),
					options.env,
				),
			),
		),
	);
