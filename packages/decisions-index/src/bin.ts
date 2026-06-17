#!/usr/bin/env node
/**
 * `decisions-index` CLI — the author + CI surface for ADR 0066.
 *
 *   node src/bin.ts generate          # rewrite .decisions/index.md from the ADR files
 *   node src/bin.ts check             # CI gate: exit non-zero on a stale index or a dup id
 *   node src/bin.ts <mode> --dir <d>  # point at a specific .decisions dir (else: repo-root .decisions)
 *
 * With no --dir the dir is resolved against the REPO ROOT (walk up for a
 * `.decisions`/workspace marker), not the cwd — so `pnpm --filter <pkg> generate`,
 * whose cwd is the package dir, finds the root `.decisions` instead of ENOENT (#447).
 *
 * `generate` is what the `/adr` skill (and an author) runs instead of hand-editing
 * the table; `check` is the CI gate that fails on (a) a committed `index.md` that
 * differs from the generated one (stale) and (b) a duplicate ADR `id` — closing the
 * number-collision class in the same step (ADR 0066).
 *
 * Exit-code contract: 0 = clean (check passed / generate wrote), any non-zero =
 * failure — both a gate failure (stale index or duplicate id; report on stderr)
 * and an IO failure (e.g. the dir is unreadable) exit non-zero, undistinguished.
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger` /
 * `@kampus/leak-guard` / `changelog-derive`): `effect/unstable/cli`, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {existsSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type AdrFile, buildIndex, DuplicateIdError, findRootDir} from "./decisions-index.ts";

const INDEX_FILE = "index.md";
const ADR_FILE = /^\d+[A-Za-z]*-.+\.md$/;
const GATE_FAIL_EXIT_CODE = 1;
const DECISIONS_DIR = ".decisions";
// Repo-root markers, in priority order. `.decisions` itself is the strongest
// signal (the dir we'll read); a workspace/VCS marker is the fallback.
const ROOT_MARKERS = [DECISIONS_DIR, "pnpm-workspace.yaml", ".git"] as const;

/**
 * Resolve the default `.decisions` directory against the REPO ROOT, not the cwd.
 *
 * `pnpm --filter <pkg> <script>` runs with cwd = the package dir, so a bare
 * `.decisions` default resolves to `packages/decisions-index/.decisions` and
 * ENOENTs (#447). Walk up from cwd for the first ancestor carrying a repo-root
 * marker and read `.decisions` there; this is foreign-repo-safe (no phoenix path
 * hardcoded) and keeps CI working (it runs from the root, where cwd === root).
 * If no marker is found we fall back to cwd's `.decisions` — the pre-fix behavior.
 */
const defaultDecisionsDir = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return join(root ?? start, DECISIONS_DIR);
};

// A directory/file IO failure: the run couldn't complete. Uncaught — it falls through
// to NodeRuntime's default handler (stack trace + non-zero exit).
class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

// Carries the non-zero gate-fail exit (the report is already on stderr).
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

// Optional, not defaulted: an absent --dir resolves to the repo-root `.decisions`
// (see `defaultDecisionsDir`); a passed --dir is honored verbatim, relative to cwd.
const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the .decisions directory to read ADR files from (default: the repo-root .decisions)",
	),
);

const resolveDir = (dir: Option.Option<string>): string =>
	Option.getOrElse(dir, () => defaultDecisionsDir());

const generate = Command.make(
	"generate",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		const dir = resolveDir(dirOpt);
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
	Effect.fn(function* ({dir: dirOpt}) {
		const dir = resolveDir(dirOpt);
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
	Command.run({version: "0.1.0"}),
	// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
	// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
	// default error report (also a non-zero exit — both are failures, undistinguished).
	Effect.catchTag("CheckFailed", (e) =>
		Effect.sync(() => {
			process.stderr.write(`decisions-index: ${e.reason}\n`);
			process.exit(GATE_FAIL_EXIT_CODE);
		}),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
