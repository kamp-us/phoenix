#!/usr/bin/env node
/**
 * `doc-links` CLI — the CI surface for the repo-wide dead-internal-link gate (#638).
 *
 *   node src/bin.ts check            # CI gate: exit non-zero on any dead internal doc link
 *   node src/bin.ts check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * `review-doc` is PR-scoped, so a file rename/delete only orphans links in docs
 * *outside* that PR's diff and nothing re-checks the rest of the tree. This gate
 * closes that gap: it walks every git-tracked `.md` and fails the build if a
 * relative/internal link points at a path that no longer resolves on disk. External
 * links (`http(s):`, `mailto:`) and links inside code spans/fences are skipped — see
 * `doc-links.ts`. The scan/IO lives in `gate.ts`; this file wires it to the CLI and
 * the exit-code contract.
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> check`, whose cwd is the package dir, scans the
 * whole repo, not just the package — same fix as decisions-index #447).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * dead link; report on stderr) and an IO failure (e.g. git/fs unreadable) exit
 * non-zero, undistinguished. Wired per effect-smol's CLI guidance (mirrors
 * `@kampus/decisions-index` / `@kampus/leak-guard`): `effect/unstable/cli`, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "./doc-links.ts";
import {checkLinks} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

const defaultRoot = (from: string = process.cwd()): string => {
	const start = resolve(from);
	const root = findRootDir(
		start,
		(dir) => ROOT_MARKERS.some((marker) => existsSync(join(dir, marker))),
		dirname,
	);
	return root ?? start;
};

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		"the repo root to scan git-tracked .md files under (default: walk up for one)",
	),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* checkLinks(resolveRoot(rootOpt));
	}),
).pipe(Command.withDescription("Fail the build if any internal doc link is dead"));

const cli = Command.make("doc-links").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Repo-wide dead-internal-link gate for docs (#638)"),
);

cli.pipe(
	Command.run({version: "0.1.0"}),
	// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
	// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
	// default error report (also a non-zero exit — both are failures, undistinguished).
	Effect.catchTag("CheckFailed", (e) =>
		Effect.sync(() => {
			process.stderr.write(`doc-links: ${e.reason}\n`);
			process.exit(GATE_FAIL_EXIT_CODE);
		}),
	),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
