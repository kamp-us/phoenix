/**
 * `guard leak-guard scan <file>...` — the authoritative no-machine-local-paths gate over a change's
 * files, ported off `pipeline-cli leak-guard scan` (epic #5720).
 *
 * The argument shape is part of the port: CI resolves the diff and hands the file list in, because
 * the scan's scope IS the change. The verb self-scopes from there — `findLeaks` reads only doc and
 * shell surfaces — so a workflow may hand it every changed file without filtering.
 *
 * **An empty list reds.** v1 answered a zero-file invocation with a clean pass, which is the one
 * shape a broken caller produces and the one a gate must never reward (ADR 0092). A file that could
 * not be READ reds too, on the UNKNOWN seat rather than the violation one — v1 skipped it silently,
 * and a skipped file is indistinguishable from a clean one, which is the #4496 class exactly.
 */

import {Effect, type FileSystem, Path} from "effect";
import {exists, type ReadFailed, readFile} from "../io/fs.ts";
import type {VerbOutcome} from "../verb.ts";
import {type Annotation, atFile} from "./annotate.ts";
import {findLeaks, isSelfExempt, type ScannedFile, scopeLine, surfaceOf} from "./leak.ts";
import {
	annotationsOrNone,
	clean,
	emitVerdict,
	type GuardVerdict,
	unknown,
	violation,
	zeroScope,
} from "./verdict.ts";

const VERB = "guard leak-guard scan";

export interface LeakGuardOptions {
	/** The changed files to scan, as the workflow resolved them — repo-relative or absolute. */
	readonly files: ReadonlyArray<string>;
	/** What a relative handed path is resolved against. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * One handed file's outcome.
 *
 * A path that is simply gone resolves to no leaks rather than failing: `--diff-filter=ACMR` drops
 * deletions, but a rename's source can still reach a caller that filters differently, and a file
 * that is not there carries no bytes to leak. A file that EXISTS and cannot be read is the
 * different case, and it leaves on the `ReadFailed` channel.
 */
const scanOne = (
	root: string,
	file: string,
): Effect.Effect<ScannedFile, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const target = path.resolve(root, file);
		const shape = {file, surface: surfaceOf(file), exempt: isSelfExempt(file)};
		if (!(yield* exists(target))) return {...shape, leaks: []};
		return {...shape, leaks: findLeaks(file, yield* readFile(target))};
	});

const leakReport = (
	flagged: ReadonlyArray<ScannedFile>,
	scanned: ReadonlyArray<ScannedFile>,
): string =>
	[
		`${VERB}: machine-local path(s) in shared artifact surface(s) — ${scopeLine(scanned)} (#173, #4496):`,
		...flagged.flatMap(({file, leaks}) =>
			leaks.map((leak) => `  ${file}: ${leak.matched} — ${leak.reason}`),
		),
		"",
		"Use a repo-relative path (apps/web/..., claude-plugins/fabrika/skills/...). If this is a",
		"documented pattern rather than a real path, add the surface to DOC_SELF_EXEMPT in",
		"packages/fabrika-cli/src/guard/leak.ts.",
	].join("\n");

const annotate = (flagged: ReadonlyArray<ScannedFile>): ReadonlyArray<Annotation> =>
	flagged.flatMap(({file, leaks}) =>
		leaks.map((leak) =>
			atFile(
				"error",
				file,
				`${leak.matched} — ${leak.reason}. A shared artifact carries no machine-local path (#173). Fix: write it repo-relative.`,
			),
		),
	);

const judge = (
	options: LeakGuardOptions,
): Effect.Effect<GuardVerdict, ReadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (options.files.length === 0) {
			return zeroScope(
				`${VERB}: handed ZERO files — the scan covered nothing, so it proves nothing, fail-closed (ADR 0092). The caller resolves the changed-file list; an empty one is a broken caller, never a clean diff.`,
			);
		}
		const scanned: Array<ScannedFile> = [];
		for (const file of options.files) scanned.push(yield* scanOne(options.cwd, file));
		const flagged = scanned.filter((result) => result.leaks.length > 0);
		if (flagged.length === 0) {
			return clean(
				`${VERB}: clean — no machine-local path in any scanned surface (${scopeLine(scanned)})`,
				scanned.length,
			);
		}
		return violation(
			leakReport(flagged, scanned),
			annotationsOrNone(() => annotate(flagged)),
		);
	});

export const runLeakGuard = (
	options: LeakGuardOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	judge(options).pipe(
		Effect.map((verdict) => emitVerdict(verdict, options.env)),
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				emitVerdict(
					unknown(
						`${VERB}: cannot read ${failure.path}: ${failure.reason} — a handed file went unscanned, so the verdict is UNKNOWN, never clean.`,
					),
					options.env,
				),
			),
		),
	);
