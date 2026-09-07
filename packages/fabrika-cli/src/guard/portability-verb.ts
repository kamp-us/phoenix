/**
 * `guard portability-guard check` — fabrika's own shipped text carries no reference that resolves
 * only in the repository it is being developed in.
 *
 * The verb owns the scope walk, the allow-list read and the fail-closed floors, the way
 * `./no-gh-verb.ts` does: a scan whose root resolved elsewhere, matched no file, or skipped a whole
 * group directory is a ZERO_SCOPE red rather than a green over nothing. The matchers and the
 * ceiling arithmetic stay pure in `./portability.ts`.
 *
 * Two configs, and they answer two different questions. `.fabrika.jsonc`'s `portability` key says
 * which *names* belong to this repository — policy an adopter rewrites. The allow-list at
 * {@link CONFIG_PATH} is this repository's own ledger of what has not been swept yet, so it lives
 * outside the two trees the guard scans and never ships with the plugin.
 */

import {Effect, FileSystem, Option, Path} from "effect";
import {portabilityKey} from "../config/keys/portability.ts";
import {readKey} from "../config/read-key.ts";
import {discoverRepoRoot} from "../delegate/root.ts";
import {type ReadFailed, readDir, readFile, realPath} from "../io/fs.ts";
import {parseJson} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	type Allowance,
	annotationsFor,
	type FileScan,
	isInScope,
	judge,
	type PortabilityConfig,
	renderReport,
	SCAN_ROOTS,
	scanFile,
	type Unit,
} from "./portability.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard portability-guard check";

/** The floor and the carve-outs, at the repo root — outside both scanned trees, on purpose. */
export const CONFIG_PATH = "portability-guard.config.json";

/**
 * The directories each scanned root must contribute a file from.
 *
 * A walk narrowed to one corner still reports green over the corners it never entered, and a green
 * from an empty corner reads exactly like a green from swept text.
 */
const GROUP_ROOTS = ["claude-plugins/fabrika/skills", "packages/fabrika-cli/src"] as const;

const walk = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	root: string,
	dir: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const found: Array<string> = [];
		for (const name of yield* readDir(path.join(root, dir))) {
			const relative = `${dir}/${name}`;
			const abs = path.join(root, relative);
			const stat = yield* Effect.option(fs.stat(abs));
			if (Option.isNone(stat)) continue;
			if (stat.value.type === "Directory") {
				if (name === "node_modules" || name === "dist") continue;
				found.push(...(yield* walk(fs, path, root, relative)));
				continue;
			}
			if (isInScope(relative)) found.push(relative);
		}
		return found.sort();
	});

const subdirectories = (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	root: string,
	dir: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const dirs: Array<string> = [];
		for (const name of yield* readDir(path.join(root, dir))) {
			const stat = yield* Effect.option(fs.stat(path.join(root, dir, name)));
			if (Option.isNone(stat) || stat.value.type !== "Directory") continue;
			dirs.push(`${dir}/${name}`);
		}
		return dirs.sort();
	});

/** The parsed allow-list, or the named reason it is unusable. */
type ConfigRead =
	| {readonly _tag: "Config"; readonly config: PortabilityConfig}
	| {readonly _tag: "Malformed"; readonly report: string};

const isAllowance = (entry: unknown): entry is Allowance =>
	entry !== null &&
	typeof entry === "object" &&
	typeof (entry as Allowance).ceiling === "number" &&
	typeof (entry as Allowance).why === "string" &&
	(entry as Allowance).why.trim().length > 0;

const isAllowanceMap = (value: unknown): value is Readonly<Record<string, Allowance>> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.values(value as Record<string, unknown>).every(isAllowance);

const isUnitMap = (value: unknown): value is Readonly<Record<string, Unit>> =>
	value !== null &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	Object.values(value as Record<string, unknown>).every(
		(entry) =>
			isAllowance(entry) &&
			Array.isArray((entry as Unit).paths) &&
			(entry as Unit).paths.length > 0 &&
			(entry as Unit).paths.every((p) => typeof p === "string" && p.trim().length > 0),
	);

const readConfig = (
	root: string,
): Effect.Effect<ConfigRead, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const parsed = parseJson(yield* readFile(path.join(root, CONFIG_PATH))) as Partial<
			Record<"exempt" | "unmigrated", unknown>
		> | null;
		if (parsed === null || !isAllowanceMap(parsed.exempt) || !isUnitMap(parsed.unmigrated)) {
			return {
				_tag: "Malformed",
				report: `${VERB}: ${CONFIG_PATH} does not parse, or an entry is missing a numeric \`ceiling\`, a non-empty \`why\`, or (under \`unmigrated\`) a non-empty \`paths\` list — the allow-list the floor is judged against is broken, so the verdict is fail-closed.\n`,
			};
		}
		return {_tag: "Config", config: {exempt: parsed.exempt, unmigrated: parsed.unmigrated}};
	});

const gather = (
	root: string,
	repoNames: ReadonlyArray<string>,
): Effect.Effect<
	{readonly files: ReadonlyArray<FileScan>; readonly refusal: string | null},
	ReadFailed,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const expectedRoot = yield* realPath(root);
		const paths: Array<string> = [];
		for (const tree of SCAN_ROOTS) {
			const resolved = yield* realPath(path.join(root, tree));
			if (resolved !== path.join(expectedRoot, tree)) {
				return {
					files: [],
					refusal: `the scan root ${tree}/ resolves to ${resolved}, not ${path.join(expectedRoot, tree)} — the walk would scan another tree, or nothing`,
				};
			}
			const found = yield* walk(fs, path, root, tree);
			if (found.length === 0) {
				return {files: [], refusal: `the walk of ${tree}/ matched ZERO readable text files`};
			}
			paths.push(...found);
		}
		for (const group of GROUP_ROOTS) {
			const missing: Array<string> = [];
			for (const dir of yield* subdirectories(fs, path, root, group)) {
				if (!paths.some((p) => p.startsWith(`${dir}/`))) missing.push(dir);
			}
			if (missing.length > 0) {
				return {
					files: [],
					refusal: `these directories contributed ZERO scanned files, so the walk does not cover them: ${missing.join(", ")}`,
				};
			}
		}
		const scans: Array<FileScan> = [];
		for (const relative of paths) {
			scans.push({
				path: relative,
				hits: scanFile(relative, yield* readFile(path.join(root, relative)), repoNames),
			});
		}
		return {files: scans, refusal: null};
	});

const judgeTree = (
	root: string,
	cwd: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const names = yield* readKey(cwd, portabilityKey);
		if (names._tag === "Refused") {
			return zeroScope(
				`${VERB}: ${names.reason} — the guard cannot judge a name it never read, so the verdict is fail-closed.\n`,
			);
		}
		const config = yield* readConfig(root);
		if (config._tag === "Malformed") return zeroScope(config.report);
		const gathered = yield* gather(root, names.value.repoNames);
		if (gathered.refusal !== null) {
			return zeroScope(`${VERB}: ${gathered.refusal}. Fail-closed.\n`);
		}
		const verdict = judge({files: gathered.files, config: config.config});
		const report = renderReport(VERB, verdict);
		if (verdict._tag === "Clean") return clean(report.trimEnd(), verdict.filesScanned);
		if (verdict._tag === "ZeroScope") return zeroScope(report);
		return violation(
			report,
			annotationsOrNone(() => annotationsFor(verdict)),
		);
	});

export interface PortabilityGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runPortabilityGuard = (
	options: PortabilityGuardOptions,
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
		return emitVerdict(yield* judgeTree(root, options.root ?? options.cwd), options.env);
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
