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
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {
	type AdrFile,
	buildCompact,
	buildIndex,
	buildNext,
	DuplicateIdError,
} from "./decisions-index.ts";

const INDEX_FILE = "index.md";
const ADR_FILE = /^\d+[A-Za-z]*-.+\.md$/;

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

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

/** Fold a builder's throw (a duplicate id or a malformed file) into a CheckFailed. */
const toGateFail = (build: () => string): Effect.Effect<string, CheckFailed> =>
	Effect.try({
		try: build,
		catch: (cause) =>
			cause instanceof DuplicateIdError
				? new CheckFailed({reason: cause.message})
				: new CheckFailed({reason: String((cause as Error)?.message ?? cause)}),
	});

/** Build the index, folding a duplicate id into a CheckFailed gate failure. */
export const build = (files: ReadonlyArray<AdrFile>): Effect.Effect<string, CheckFailed> =>
	toGateFail(() => buildIndex(files));

/** Build the compact ambient map (ADR 0126), same duplicate-id fold as `build`. */
export const buildCompactMap = (
	files: ReadonlyArray<AdrFile>,
): Effect.Effect<string, CheckFailed> => toGateFail(() => buildCompact(files));

/** Derive the next free ADR number (#2064), same duplicate-id fold as `build`. */
export const buildNextNumber = (
	files: ReadonlyArray<AdrFile>,
): Effect.Effect<string, CheckFailed> => toGateFail(() => buildNext(files));

/**
 * The PR-time gate after the index stopped being committed per-PR (ADR 0066, issue
 * #1492). It parses every ADR file via `build` — so a duplicate id, a
 * filename/front-matter number mismatch, or a malformed file still fails the build
 * (the #1471 number-collision guard is preserved) — but it does **not** compare
 * against the committed `index.md`. Dropping the freshness comparison is the point:
 * ADR PRs no longer carry the regenerated index, so they can't collide on it; the
 * index is regenerated and committed on merge to main instead (the `decisions-index`
 * workflow's push job). The built markdown is discarded — validation is the only effect.
 */
export const validateAdrs = (dir: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		yield* readAdrFiles(dir).pipe(Effect.flatMap(build));
		yield* Console.log("decisions-index: ADR files valid (no duplicate or mismatched id)");
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
 * Emit the compact ambient ADR map to stdout — one line per ADR (`id · title ·
 * status`), the map the SessionStart hook injects (ADR 0126 / #1728). Pure read: it
 * derives from the ADR frontmatter with no committed-file dependency, so it never
 * drifts and needs no regenerate step. `Console.log` writes the map to stdout.
 */
export const compactIndex = (dir: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const map = yield* readAdrFiles(dir).pipe(Effect.flatMap(buildCompactMap));
		yield* Console.log(map);
	});

/**
 * Emit the next free ADR number to stdout — the deterministic allocator an author
 * runs instead of eyeballing `.decisions/` before `/adr` (#2064). Pure read over the
 * ADR frontmatter: `max(id) + 1`, zero-padded (e.g. `0152`). It fails `CheckFailed`
 * on an already-broken tree (duplicate / mismatched id) rather than allocate over it —
 * the same fold `validate` uses, so `next` and `validate` never disagree.
 */
export const nextIndex = (dir: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const next = yield* readAdrFiles(dir).pipe(Effect.flatMap(buildNextNumber));
		yield* Console.log(next);
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
