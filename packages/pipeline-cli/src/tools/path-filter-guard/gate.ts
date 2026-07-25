/**
 * The `path-filter-guard` filesystem gate (issue #2372) — the IO seam behind the
 * ci.yml/deploy.yml path-filter sync check, split from `command.ts` so it is crossable in
 * unit tests over a fake repo dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom; #855).
 *
 * `checkPathFilters` is the CI gate: it reads the two workflow files and delegates the
 * verdict to the pure core (`path-filter-guard.ts`). It fails `CheckFailed` (exit
 * non-zero) on drift (the two path sets differ) or zero scope (a missing file/job/step/
 * key or an empty list — fail-closed, ADR 0092). A file that cannot be read is an
 * `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {CI_E2E_SOURCE, DEPLOY_SOURCE, judge, renderReport} from "./path-filter-guard.ts";

/** A file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

// File IO goes through the Effect `FileSystem`/`Path` seam (over the bin's
// `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for the real
// disk (.patterns/effect-platform-access.md); a fs fault folds `PlatformError` → the
// `IoError` this gate already carries.
const readWorkflow = (
	root: string,
	relPath: string,
): Effect.Effect<string, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, relPath);
		return yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
	});

/**
 * The CI gate: succeed when ci.yml's `changes.e2e` and deploy.yml's `changes.deploy`
 * dorny/paths-filter lists are the same set, else `CheckFailed`. Fails closed on any
 * zero-scope gap (ADR 0092).
 */
export const checkPathFilters = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const ciText = yield* readWorkflow(root, CI_E2E_SOURCE.file);
		const deployText = yield* readWorkflow(root, DEPLOY_SOURCE.file);
		const verdict = judge({ciText, deployText});
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
