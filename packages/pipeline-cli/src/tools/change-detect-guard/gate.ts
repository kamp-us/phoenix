/**
 * The `change-detect-guard` filesystem gate (#3245) — the IO seam behind the ci.yml
 * API-free-git-mode check, split from `command.ts` so it is crossable in unit tests over a
 * fake repo dir rather than only by spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkChangeDetect` is the CI gate: it reads ci.yml and delegates the verdict to the pure
 * core (`change-detect-guard.ts`). It fails `CheckFailed` (exit non-zero) when the dorny
 * step is in GitHub-API mode (a set/defaulted token — the flake path) or on zero scope (a
 * missing job/step/`with:` — fail-closed, ADR 0092). A file that cannot be read is an
 * `IoError` (also non-zero — both failures, undistinguished, per the bin's contract).
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {CI_CHANGES_SOURCE, judge, renderReport} from "./change-detect-guard.ts";

/** A file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const readWorkflow = (root: string, relPath: string): Effect.Effect<string, IoError> =>
	Effect.try({
		try: () => readFileSync(join(root, relPath), "utf8"),
		catch: (cause) => new IoError({path: join(root, relPath), cause}),
	});

/**
 * The CI gate: succeed when ci.yml's changes-job dorny/paths-filter step sets `token: ''`
 * (API-free git-mode detection), else `CheckFailed`. Fails closed on any zero-scope gap
 * (ADR 0092).
 */
export const checkChangeDetect = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const ciText = yield* readWorkflow(root, CI_CHANGES_SOURCE.file);
		const verdict = judge(ciText);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
