/**
 * The `roadmap-guard` gate — the IO seam wiring the pure core to the two facts it
 * judges: `ROADMAP.md`'s text (read from disk) and the live milestone projection (read
 * over `gh api` via the `Milestones` service). Split from `command.ts` so the wiring is
 * crossable in tests, and kept thin: it reads, delegates the verdict to `roadmap-guard.ts`,
 * and fails `CheckFailed` (exit non-zero) on any non-passing verdict — including the
 * zero-scope fail-closed (ADR 0092). An IO/`gh` failure is a distinct typed error (also
 * non-zero — both are failures, undistinguished, per the bin's contract).
 */
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import type * as Schema from "effect/Schema";
import type {GhCommandError, GhParseError, RepoResolutionError} from "./github.ts";
import {Milestones} from "./github.ts";
import {judge, parseRoadmap, renderReport} from "./roadmap-guard.ts";

/** Couldn't read `ROADMAP.md` (absent or unreadable). */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const ROADMAP_FILE = "ROADMAP.md";

const readRoadmap = (root: string): Effect.Effect<string, IoError> =>
	Effect.try({
		try: () => {
			const path = join(root, ROADMAP_FILE);
			if (!existsSync(path)) {
				throw new Error(`${ROADMAP_FILE} not found at repo root`);
			}
			return readFileSync(path, "utf8");
		},
		catch: (cause) => new IoError({path: join(root, ROADMAP_FILE), cause}),
	});

/**
 * The CI gate: parse `ROADMAP.md`'s `## Arcs`/`## Campaigns` tables, read the live
 * milestone projection, and judge I1–I4 (extended to campaign rows). Succeeds only on a
 * passing verdict; every non-pass — including zero-scope — is a `CheckFailed`.
 */
export const checkRoadmap = (
	root: string,
): Effect.Effect<
	void,
	IoError | CheckFailed | RepoResolutionError | GhCommandError | GhParseError | Schema.SchemaError,
	Milestones
> =>
	Effect.gen(function* () {
		const md = yield* readRoadmap(root);
		const {arcs, campaigns} = parseRoadmap(md);
		const milestones = yield* (yield* Milestones).list();
		const verdict = judge(arcs, campaigns, milestones);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
