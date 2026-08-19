/**
 * `guard publish-isolation-guard check` — every published package installs from a clean registry
 * (ADR 0201 §3, #3802), ported off v1's `publish-isolation-guard check` (epic #5720).
 *
 * The verb is the IO boundary: derive the published set from `publish.yml`, read the workspace
 * members behind it, hand the manifests to the pure rule in `./publish-isolation.ts`, seat the
 * answer on the group's exit taxonomy.
 *
 * **v1's single non-zero exit splits into three seats here.** A missing publish.yml, a prefix that
 * maps to no member, and a zero-prefix workflow are all broken scope (`7`, ADR 0092); an unreadable
 * or unparseable manifest is UNKNOWN (`11`); only a real linked private dep is the violation (`12`).
 * All three stay red, so the gate's strictness is unchanged.
 */

import {Effect, type FileSystem, Path} from "effect";
import {discoverRepoRoot} from "../delegate/root.ts";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import {isRecord, parseJson} from "../io/json.ts";
import type {VerbOutcome} from "../verb.ts";
import {atFile} from "./annotate.ts";
import {scanWorkspaceMembers} from "./members.ts";
import {
	judge,
	manifestRuntimeDeps,
	type PublishedManifest,
	parsePublishedTagPrefixes,
	renderReport,
	resolvePublished,
	violationLine,
} from "./publish-isolation.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard publish-isolation-guard check";

/** The release pipeline that defines which packages publish — the guard's scope source. */
const PUBLISH_WORKFLOW = ".github/workflows/publish.yml";

const MANIFEST = "package.json";

export interface PublishIsolationGuardOptions {
	/** An explicit repo root, or `null` to walk up from `cwd` for one. */
	readonly root: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Every workspace member as a {@link PublishedManifest}. The ROOT manifest is out of scope by
 * construction — `scanWorkspaceMembers` walks the declared member globs, and the root workspace
 * never publishes.
 */
const readMembers = (
	root: string,
): Effect.Effect<
	{
		readonly members: ReadonlyArray<PublishedManifest>;
		/** Repo-relative paths of the manifests whose bytes were read but were not JSON. */
		readonly unparseable: ReadonlyArray<string>;
	},
	ReadFailed,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const scan = yield* scanWorkspaceMembers(root);
		const members: Array<PublishedManifest> = [];
		const unparseable: Array<string> = [];
		for (const member of scan.members) {
			const rel = `${member.dir}/${MANIFEST}`;
			const pkg = parseJson(yield* readFile(path.join(root, rel)));
			if (!isRecord(pkg)) {
				unparseable.push(rel);
				continue;
			}
			members.push({
				path: rel,
				name: typeof pkg.name === "string" ? pkg.name : rel,
				deps: manifestRuntimeDeps(pkg),
			});
		}
		return {members, unparseable};
	});

const judgeRoot = (
	root: string,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const workflow = path.join(root, PUBLISH_WORKFLOW);
		if (!(yield* exists(workflow))) {
			return zeroScope(
				`${VERB}: ${root}/${PUBLISH_WORKFLOW} does not exist — the published set is derived from it, so the guard has no scope at all, fail-closed (ADR 0092). Is the repo root correct?`,
			);
		}
		const prefixes = parsePublishedTagPrefixes(yield* readFile(workflow));
		const {members, unparseable} = yield* readMembers(root);
		if (unparseable.length > 0) {
			return unknown(
				`${VERB}: ${unparseable.length} workspace manifest(s) do not parse as JSON — their runtime deps could not be judged, so the verdict is UNKNOWN, never clean:\n${unparseable
					.map((rel) => `  ${rel}`)
					.join("\n")}`,
			);
		}
		const {published, unmatchedPrefixes} = resolvePublished(prefixes, members);
		if (unmatchedPrefixes.length > 0) {
			return zeroScope(
				`${VERB}: publish.yml release-tag prefix(es) [${unmatchedPrefixes.join(", ")}] map to no workspace member — the guard's scope assumption is broken, fail-closed (ADR 0092). The tag grammar and the package's unscoped name have drifted; re-sync publish.yml's \`<name>-v<version>\` grammar with the package name.`,
			);
		}
		const verdict = judge(published);
		const report = renderReport(VERB, verdict);
		if (verdict.pass) return clean(report, verdict.scanned.length);
		if (verdict.reason === "zero-scope") return zeroScope(report);
		return violation(
			report,
			annotationsOrNone(() =>
				verdict.violations.map((v) => atFile("error", v.path, violationLine(v).trim())),
			),
		);
	});

export const runPublishIsolationGuard = (
	options: PublishIsolationGuardOptions,
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
		return emitVerdict(yield* judgeRoot(root), options.env);
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
