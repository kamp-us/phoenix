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
 * number-collision class in the same step (ADR 0066). The branchy gate itself lives
 * in `gate.ts` (`checkIndex`/`generateIndex`), so it is unit-testable over a fake
 * `.decisions` dir; this file wires it to the CLI and the exit-code contract.
 *
 * Exit-code contract: 0 = clean (check passed / generate wrote), any non-zero =
 * failure — both a gate failure (stale index or duplicate id; report on stderr)
 * and an IO failure (e.g. the dir is unreadable) exit non-zero, undistinguished.
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/epic-ledger` /
 * `@kampus/leak-guard` / `changelog-derive`): `effect/unstable/cli`, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "./decisions-index.ts";
import {checkIndex, generateIndex} from "./gate.ts";

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
		yield* generateIndex(resolveDir(dirOpt));
	}),
).pipe(Command.withDescription("Regenerate .decisions/index.md from the ADR files"));

const check = Command.make(
	"check",
	{dir: dirFlag},
	Effect.fn(function* ({dir: dirOpt}) {
		yield* checkIndex(resolveDir(dirOpt));
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
