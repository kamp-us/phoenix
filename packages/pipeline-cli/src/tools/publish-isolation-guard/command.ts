/**
 * The `publish-isolation-guard` tool — `pipeline-cli publish-isolation-guard check [--root <d>]`.
 *
 * The CI surface for ADR 0201 §3's isolated-publishing mandate: every package the
 * release pipeline (`publish.yml`) ships must be installable from a clean registry
 * state — zero phoenix-private `@kampus/*` deps, no `workspace:*` links. Enforced
 * fail-closed so the #3802 class (pipeline-cli@0.2.0 published green yet uninstallable)
 * can't silently re-drift:
 *
 *   pipeline-cli publish-isolation-guard check            # CI gate: exit non-zero on any private/workspace dep link
 *   pipeline-cli publish-isolation-guard check --root <d> # point at a specific repo root (else: walk up for one)
 *
 * SCOPE — DERIVED from publish.yml's release-tag grammar (`<name>-v<version>`), mapped
 * to workspace members by unscoped package name; never a hardcoded ad-hoc list. Only
 * the runtime dep fields (`dependencies`/`optionalDependencies`/`peerDependencies`)
 * ship in the tarball, so `devDependencies` are out of scope. Fail-closed on a tag
 * prefix that maps to no member (drift) and on zero published packages (ADR 0092). The
 * scan/IO lives in `gate.ts`; this file wires it to the CLI (the thin-CLI-over-`gate.ts`
 * idiom shared across the guards).
 *
 * With no --root the repo root is resolved by walking UP from cwd for a workspace
 * marker (so `pnpm --filter <pkg> …`, whose cwd is the package dir, scans the whole
 * repo, not just the package).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — both a gate failure (a
 * private/workspace dep link; report on stderr) and an IO failure (fs unreadable) exit
 * non-zero, undistinguished. `CheckFailed` is caught inside the handler (not at the
 * bin's run boundary) so the contract survives folding into the shared `pipeline-cli`
 * bin, which provides only `NodeServices.layer` and no per-tool catch.
 */
import {Effect, FileSystem, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CheckFailed, checkPublishIsolation} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
// Repo-root markers, in priority order: a pnpm workspace, then a VCS dir.
const ROOT_MARKERS = ["pnpm-workspace.yaml", ".git"] as const;

// Walk up from cwd for the first ancestor bearing a repo-root marker, probing each
// marker through the `FileSystem`/`Path` seam so the resolver is testable off real
// disk (.patterns/effect-platform-access.md). Marker-existence faults fall through as
// false, matching `existsSync`.
const defaultRoot = Effect.fn(function* (from: string = process.cwd()) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const start = path.resolve(from);
	let dir = start;
	for (;;) {
		for (const marker of ROOT_MARKERS) {
			if (yield* fs.exists(path.join(dir, marker)).pipe(Effect.orElseSucceed(() => false)))
				return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
});

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription(
		"the repo root to derive the published-package set + scan manifests under (default: walk up for one)",
	),
);

const resolveRoot = (
	root: Option.Option<string>,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
	Option.match(root, {onNone: () => defaultRoot(), onSome: Effect.succeed});

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, etc.) still get the
// default error report (also a non-zero exit — both are failures, undistinguished).
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		const root = yield* resolveRoot(rootOpt);
		yield* checkPublishIsolation(root).pipe(Effect.catchTag("CheckFailed", onCheckFailed));
	}),
).pipe(
	Command.withDescription(
		"Fail the build if any published pipeline package links a private/unpublished @kampus dep",
	),
);

export const publishIsolationGuardCommand = Command.make("publish-isolation-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Fail-closed gate: every published pipeline package is installable in isolation, zero private @kampus deps (ADR 0201 §3, #3802)",
	),
);
