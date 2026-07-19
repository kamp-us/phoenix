/**
 * The `design-inventory` tool — `pipeline-cli design-inventory generate
 * [--root <d>] [--stdout] [--check]` (issue #3155, epic #3150, ADR 0194).
 *
 * The self-updating extractor for the DESCRIPTIVE component inventory: it reads the
 * JSDoc-on-code metadata off the shipped `components/ui` primitives and emits one central
 * curated-hybrid index (inline the when-to-use core, link to source for depth).
 *
 *   pipeline-cli design-inventory generate            # write design-system-inventory.md from the primitives' JSDoc
 *   pipeline-cli design-inventory generate --stdout   # print the index instead of writing it
 *   pipeline-cli design-inventory generate --check     # red on drift (freshness signal)
 *   pipeline-cli design-inventory generate --root <d> # point at a specific repo root (else: walk up for one)
 *   pipeline-cli design-inventory check               # the CI guard: red on a stale inventory (#3156)
 *
 * FIREWALL (ADR 0194): the tool writes ONLY the descriptive inventory artifact; the
 * normative manifest (four pillars / prohibitions / role-token values) is founder-authored
 * and unreachable from here — enforced in `gate.ts`'s `writeDescriptiveArtifact`, not just
 * intended. The extraction/IO lives in `gate.ts`; this file wires it to the CLI (mirrors
 * `readme-guard` / `design-token-guard`).
 *
 * Exit-code contract: 0 = clean, any non-zero = failure — a gate failure (zero scope or a
 * `--check` drift; report on stderr) and an IO failure exit non-zero, undistinguished.
 * `CheckFailed` is caught inside the handler (not at the bin's run boundary) so the contract
 * survives folding into the shared `pipeline-cli` bin, which provides only `NodeServices.layer`.
 */
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, generateInventory} from "./gate.ts";

const GATE_FAIL_EXIT_CODE = 1;
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
	Flag.withDescription("the repo root to extract the component inventory under (default: walk up)"),
);

const stdoutFlag = Flag.boolean("stdout").pipe(
	Flag.withDescription("print the rendered inventory instead of writing the artifact"),
);

const checkFlag = Flag.boolean("check").pipe(
	Flag.withDescription(
		"fail if the committed inventory is out of date (freshness check, no write)",
	),
);

const resolveRoot = (root: Option.Option<string>): string =>
	Option.getOrElse(root, () => defaultRoot());

// CheckFailed is the expected gate-fail signal — print its reason on stderr and exit
// non-zero WITHOUT a stack trace; genuine crashes (IoError, FirewallViolation) still get
// the default error report (also a non-zero exit — both are failures, undistinguished).
const onCheckFailed = (e: CheckFailed) =>
	Effect.sync(() => {
		process.stderr.write(`${e.reason}\n`);
		process.exit(GATE_FAIL_EXIT_CODE);
	});

const generate = Command.make(
	"generate",
	{root: rootFlag, stdout: stdoutFlag, check: checkFlag},
	Effect.fn(function* ({root: rootOpt, stdout, check}) {
		yield* generateInventory(resolveRoot(rootOpt), {stdout, check}).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"Extract the descriptive component inventory from the components/ui JSDoc and emit the index",
	),
);

// The canonical guard entrypoint (`pipeline-cli <tool> check`, mirroring readme-guard /
// design-token-guard) the CI job invokes — the self-update freshness rung of #3156. It reds
// when the committed inventory drifts from a fresh extraction and fails closed on zero scope;
// no write, so it's safe on a read-only checkout. It reuses the gate's `--check` path so the
// scan lives once. The firewall half of #3156 is a git-diff belt in the workflow (a mutation
// check has no home in a read-only pure gate) backed by the structural refusal in `gate.ts`.
const check = Command.make(
	"check",
	{root: rootFlag},
	Effect.fn(function* ({root: rootOpt}) {
		yield* generateInventory(resolveRoot(rootOpt), {stdout: false, check: true}).pipe(
			Effect.catchTag("CheckFailed", onCheckFailed),
		);
	}),
).pipe(
	Command.withDescription(
		"CI guard: fail closed when the committed descriptive inventory is stale vs the primitives' JSDoc",
	),
);

export const designInventoryCommand = Command.make("design-inventory").pipe(
	Command.withSubcommands([generate, check]),
	Command.withDescription(
		"Self-updating descriptive component inventory from components/ui JSDoc (issue #3155, ADR 0194)",
	),
);
