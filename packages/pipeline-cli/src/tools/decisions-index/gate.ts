/**
 * The `check`/`generate` IO gate — the filesystem seam behind ADR 0066's two
 * modes, split out of `bin.ts` so it is crossable over a fake `.decisions` dir in
 * unit tests rather than only by spawning the bin (the core-in-its-own-file idiom;
 * #855). `bin.ts` wires these effects to the Effect CLI and maps `CheckFailed` to
 * the non-zero gate exit; the exit-code contract lives there.
 *
 * `checkIndex` is the CI gate: it succeeds (exit 0) when the committed `index.md`
 * matches the freshly-built one, and fails `CheckFailed` (exit non-zero) on a stale
 * index, a duplicate ADR id, or a filename/front-matter number mismatch (all folded
 * in by `build` — `buildIndex` parses every file, so a `NumberMismatchError` from
 * `parseAdrFile` and a `DuplicateIdError` both surface here). `generateIndex`
 * rewrites the index. A directory/file IO failure is an `IoError` (also non-zero —
 * both failures, undistinguished, per the bin's contract).
 */
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {type AdrFile, buildIndex, DuplicateIdError} from "./decisions-index.ts";

const INDEX_FILE = "index.md";
const ADR_FILE = /^\d+[A-Za-z]*-.+\.md$/;

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

/** Read every ADR file (NNNN[a]-slug.md) in `dir`, excluding the generated index. */
export const readAdrFiles = (dir: string): Effect.Effect<ReadonlyArray<AdrFile>, IoError> =>
	Effect.try({
		try: () =>
			readdirSync(dir)
				.filter((f) => f !== INDEX_FILE && ADR_FILE.test(f))
				.sort()
				.map((file) => ({file, text: readFileSync(join(dir, file), "utf8")})),
		catch: (cause) => new IoError({path: dir, cause}),
	});

/** Build the index, folding a duplicate id into a CheckFailed gate failure. */
export const build = (files: ReadonlyArray<AdrFile>): Effect.Effect<string, CheckFailed> =>
	Effect.try({
		try: () => buildIndex(files),
		catch: (cause) =>
			cause instanceof DuplicateIdError
				? new CheckFailed({reason: cause.message})
				: new CheckFailed({reason: String((cause as Error)?.message ?? cause)}),
	});

/** Rewrite `<dir>/index.md` from the ADR files. */
export const generateIndex = (dir: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const markdown = yield* readAdrFiles(dir).pipe(Effect.flatMap(build));
		const target = join(dir, INDEX_FILE);
		yield* Effect.try({
			try: () => writeFileSync(target, markdown),
			catch: (cause) => new IoError({path: target, cause}),
		});
		yield* Console.log(`decisions-index: wrote ${target}`);
	});

/**
 * The CI gate: succeed when the committed `index.md` is fresh, else `CheckFailed`
 * (stale index or duplicate id). A missing/unreadable committed index reads as
 * empty, so it never matches a non-empty build → stale.
 */
export const checkIndex = (dir: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const expected = yield* readAdrFiles(dir).pipe(Effect.flatMap(build));
		const target = join(dir, INDEX_FILE);
		const committed = yield* Effect.try({
			try: () => readFileSync(target, "utf8"),
			catch: () => "",
		}).pipe(Effect.orElseSucceed(() => ""));
		if (committed === expected) {
			yield* Console.log("decisions-index: index.md is up to date");
			return;
		}
		return yield* Effect.fail(
			new CheckFailed({
				reason:
					`${target} is stale — it does not match the generated index.\n` +
					"Run `pnpm --filter @kampus/decisions-index generate` and commit the result\n" +
					"(edit the ADR file's front-matter, never index.md by hand — ADR 0066).",
			}),
		);
	});
