/**
 * The `roadmap-guard` gate — the IO seam wiring the pure core to the two facts it
 * judges: `ROADMAP.md`'s text (read from disk) and the live milestone projection (read
 * over `gh api` via the `Milestones` service). Split from `command.ts` so the wiring is
 * crossable in tests, and kept thin: it reads, delegates the verdict to `roadmap-guard.ts`,
 * and fails `CheckFailed` (exit non-zero) on any non-passing verdict — including the
 * zero-scope fail-closed (ADR 0092). An IO/`gh` failure is a distinct typed error (also
 * non-zero — both are failures, undistinguished, per the bin's contract).
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import type {GhCommandError, GhParseError, RepoResolutionError} from "./github.ts";
import {Milestones} from "./github.ts";
import {judge, parseRoadmap, renderReport} from "./roadmap-guard.ts";

/** Couldn't read `ROADMAP.md` (absent or unreadable). */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

const ROADMAP_FILE = "ROADMAP.md";

// The file read goes through the `FileSystem`/`Path` seam (over the bin's
// `NodeServices.layer`), so the wiring is crossable off real disk in a test — see
// `.patterns/effect-platform-access.md`. A missing ROADMAP.md keeps its specific
// "not found at repo root" diagnostic; a read fault folds `PlatformError` → `IoError`.
const readRoadmap = (
	root: string,
): Effect.Effect<string, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const target = path.join(root, ROADMAP_FILE);
		if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
			return yield* Effect.fail(
				new IoError({path: target, cause: new Error(`${ROADMAP_FILE} not found at repo root`)}),
			);
		}
		return yield* fs
			.readFileString(target, "utf8")
			.pipe(Effect.mapError((cause) => new IoError({path: target, cause})));
	});

/**
 * The CI gate: parse `ROADMAP.md`'s `## Arcs`/`## Campaigns`/`## Focus` tables, read the
 * live milestone projection, and judge I1–I6 (extended to campaign rows, the active↔done
 * lifecycle symmetry #2660, and the declared focus #5012). Succeeds only on a passing
 * verdict; every non-pass — including zero-scope — is a `CheckFailed`.
 */
export const checkRoadmap = (
	root: string,
): Effect.Effect<
	void,
	IoError | CheckFailed | RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError,
	Milestones | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const md = yield* readRoadmap(root);
		const {arcs, campaigns, focus} = parseRoadmap(md);
		const milestones = yield* (yield* Milestones).list();
		const verdict = judge(arcs, campaigns, milestones, focus);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
