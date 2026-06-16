/**
 * `decisions-index` CLI — the author + CI surface for ADR 0066.
 *
 *   node src/bin.ts generate          # rewrite .decisions/index.md from the ADR files
 *   node src/bin.ts check             # CI gate: exit non-zero on a stale index or a dup id
 *   node src/bin.ts <mode> --dir <d>  # point at a different .decisions dir (default: ./.decisions)
 *
 * `generate` is what the `/adr` skill (and an author) runs instead of hand-editing
 * the table; `check` is the CI gate that fails on (a) a committed `index.md` that
 * differs from the generated one (stale) and (b) a duplicate ADR `id` — closing the
 * number-collision class in the same step (ADR 0066).
 *
 * Exit-code contract: 0 = clean (check passed / generate wrote), 1 = the gate
 * failed (stale index or duplicate id; report on stderr); any OTHER non-zero means
 * the run could not complete (e.g. the dir is unreadable). Wired per effect-smol's
 * CLI guidance (mirrors `@kampus/epic-ledger` / `@kampus/leak-guard` /
 * `changelog-derive`): `effect/unstable/cli`, the Node platform over
 * `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type AdrFile, buildIndex, DuplicateIdError} from "./decisions-index.ts";

const INDEX_FILE = "index.md";
const ADR_FILE = /^\d+[A-Za-z]*-.+\.md$/;
const GATE_FAIL_EXIT_CODE = 1;

// A directory/file IO failure that should crash (non-1 exit): the run couldn't complete.
class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

// Carries the non-zero gate-fail exit (the report is already on stderr). Distinct from
// IoError so a stale index / dup id exits 1 while an unreadable dir exits differently.
class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

/** Read every ADR file (NNNN[a]-slug.md) in `dir`, excluding the generated index. */
const readAdrFiles = (dir: string): Effect.Effect<ReadonlyArray<AdrFile>, IoError> =>
	Effect.try({
		try: () =>
			readdirSync(dir)
				.filter((f) => f !== INDEX_FILE && ADR_FILE.test(f))
				.sort()
				.map((file) => ({file, text: readFileSync(join(dir, file), "utf8")})),
		catch: (cause) => new IoError({path: dir, cause}),
	});

/** Build the index, folding a duplicate id into a CheckFailed gate failure. */
const build = (files: ReadonlyArray<AdrFile>): Effect.Effect<string, CheckFailed> =>
	Effect.try({
		try: () => buildIndex(files),
		catch: (cause) =>
			cause instanceof DuplicateIdError
				? new CheckFailed({reason: cause.message})
				: new CheckFailed({reason: String((cause as Error)?.message ?? cause)}),
	});

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".decisions"),
	Flag.withDescription("the .decisions directory to read ADR files from (default: .decisions)"),
);

const generate = Command.make(
	"generate",
	{dir: dirFlag},
	Effect.fn(function* ({dir}) {
		const markdown = yield* readAdrFiles(dir).pipe(Effect.flatMap(build));
		const target = join(dir, INDEX_FILE);
		yield* Effect.try({
			try: () => writeFileSync(target, markdown),
			catch: (cause) => new IoError({path: target, cause}),
		});
		yield* Console.log(`decisions-index: wrote ${target}`);
	}),
).pipe(Command.withDescription("Regenerate .decisions/index.md from the ADR files"));

const check = Command.make(
	"check",
	{dir: dirFlag},
	Effect.fn(function* ({dir}) {
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
	}),
).pipe(
	Command.withDescription("Verify the committed index.md is fresh and has no duplicate ADR id"),
);

const cli = Command.make("decisions-index").pipe(
	Command.withSubcommands([generate, check]),
	Command.withDescription("Generate .decisions/index.md from the ADR files (ADR 0066)"),
);

cli.pipe(
	Command.run({version: "0.0.0"}),
	// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
	// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
	// default error report (a different non-zero exit, per the exit-code contract).
	Effect.catchTag("CheckFailed", (e) =>
		Effect.sync(() => {
			process.stderr.write(`decisions-index: ${e.reason}\n`);
			process.exit(GATE_FAIL_EXIT_CODE);
		}),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
