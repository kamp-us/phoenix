/**
 * `guard catalog-guard check` — every dep in every workspace `package.json` is on
 * `catalog:`/`workspace:`, never a hardcoded version (#2737), ported off
 * v1's `catalog-guard check` (epic #5720).
 *
 * The verb is scope plus IO: the members come from `./members.ts`, the root manifest is added here
 * because the catalog rule governs it too, and the rule itself lives in `./catalog.ts`.
 *
 * **v1's one non-zero exit splits into three seats here.** A tree with no manifest at all is a
 * broken scope assumption (`7`, ADR 0092), a manifest that will not parse is a scan that could not
 * judge what it read (`11`), and a hardcoded version is the thing the guard forbids (`12`). All
 * three stay red, so the gate is exactly as strict as it was.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	type AllowlistEntry,
	type CatalogViolation,
	cleanSummary,
	DEFAULT_ALLOWLIST,
	findDepLine,
	findViolations,
	manifestDeps,
	type PackageManifest,
	violationAnnotations,
	violationReport,
} from "./catalog.ts";
import {scanWorkspaceMembers} from "./members.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard catalog-guard check";

const MANIFEST = "package.json";

export interface CatalogGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The sanctioned exceptions; defaults to the guard's own reasoned allowlist. */
	readonly allowlist?: ReadonlyArray<AllowlistEntry>;
}

/** A manifest that could not be parsed — held as a verdict rather than thrown past the caller. */
interface Unparseable {
	readonly path: string;
	readonly reason: string;
}

/**
 * Every manifest in scope, read and parsed. The raw text rides along because the parsed object
 * carries no positions and the annotation wants the line the offending dep sits on (#3868).
 */
const readManifests = (
	root: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	{
		readonly read: ReadonlyArray<{readonly manifest: PackageManifest; readonly text: string}>;
		readonly unparseable: ReadonlyArray<Unparseable>;
	},
	ReadFailed,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const read: Array<{manifest: PackageManifest; text: string}> = [];
		const unparseable: Array<Unparseable> = [];
		for (const rel of paths) {
			const text = yield* readFile(path.join(root, rel));
			const parsed = parseJson(text);
			if (!isRecord(parsed)) {
				unparseable.push({path: rel, reason: "does not parse as a JSON object"});
				continue;
			}
			read.push({manifest: {path: rel, deps: manifestDeps(parsed)}, text});
		}
		return {read, unparseable};
	});

/** The repo-relative manifest paths in scope: every real workspace member, plus the root. */
const manifestPaths = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const scan = yield* scanWorkspaceMembers(root);
		const paths = new Set<string>();
		if (yield* exists(path.join(root, MANIFEST))) paths.add(MANIFEST);
		for (const member of scan.members) paths.add(`${member.dir}/${MANIFEST}`);
		return [...paths].sort();
	});

const judge = (
	root: string,
	allowlist: ReadonlyArray<AllowlistEntry>,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const paths = yield* manifestPaths(root);
		if (paths.length === 0) {
			return zeroScope(
				`${VERB}: scanned ZERO package.json manifests — fail-closed (ADR 0092). Is the repo root correct, or did the workspace shape change?`,
			);
		}
		const {read, unparseable} = yield* readManifests(root, paths);
		if (unparseable.length > 0) {
			return unknown(
				[
					`${VERB}: ${unparseable.length} manifest${unparseable.length === 1 ? "" : "s"} could not be parsed, so the deps they declare were never judged — the verdict is UNKNOWN, never clean:`,
					...unparseable.map((m) => `  ${m.path}: ${m.reason}`),
				].join("\n"),
			);
		}
		const violations = findViolations(
			read.map((r) => r.manifest),
			allowlist,
		);
		if (violations.length === 0) {
			return clean(cleanSummary(VERB, read.length), read.length);
		}
		const texts = new Map(read.map((r) => [r.manifest.path, r.text]));
		const lineOf = (v: CatalogViolation): number | null => {
			const text = texts.get(v.path);
			return text === undefined ? null : findDepLine(text, v.field, v.name);
		};
		return violation(
			violationReport(VERB, violations, read.length),
			annotationsOrNone(() => violationAnnotations(violations, lineOf)),
		);
	});

export const runCatalogGuard = (
	options: CatalogGuardOptions,
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
		return emitVerdict(yield* judge(root, options.allowlist ?? DEFAULT_ALLOWLIST), options.env);
	}).pipe(
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — the scan could not be completed, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
