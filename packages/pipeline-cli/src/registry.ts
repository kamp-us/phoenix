/**
 * The pipeline-cli tool registry — the extension seam (epic #994).
 *
 * Each entry is one pipeline tool exposed as `pipeline-cli <name> …`. A Phase-2
 * child folds its tool in by authoring an `effect/unstable/cli` `Command` and
 * appending it to `registeredTools` here — it never reshapes the router core
 * (`router.ts`) or the bin (`bin.ts`), both of which consume this array opaquely.
 *
 * That is the whole contract of the seam: the router is closed for modification
 * and the registry is open for extension. A tool's subcommand surface (its own
 * args/flags) lives on the `Command` it registers, not here.
 */
import type {NodeServices} from "@effect/platform-node";
import type {Command} from "effect/unstable/cli";
import {campaignCommand} from "./tools/campaign/command.ts";
import {catalogGuardCommand} from "./tools/catalog-guard/command.ts";
import {changelogDeriveCommand} from "./tools/changelog-derive/command.ts";
import {ciRequiredCommand} from "./tools/ci-required/command.ts";
import {classProbeCommand} from "./tools/class-probe/command.ts";
import {codeownersCpCommand} from "./tools/codeowners-cp/command.ts";
import {crabboxManifestCommand} from "./tools/crabbox-manifest/command.ts";
import {decisionsIndexCommand} from "./tools/decisions-index/command.ts";
import {designTokenGuardCommand} from "./tools/design-token-guard/command.ts";
import {epicLedgerCommand} from "./tools/epic-ledger/command.ts";
import {epicLockCommand} from "./tools/epic-lock/command.ts";
import {evalHarnessCommand} from "./tools/eval-harness/command.ts";
import {failureClassifierCommand} from "./tools/failure-classifier/command.ts";
import {fanoutGuardCommand} from "./tools/fanout-guard/command.ts";
import {ghPhoenixCommand} from "./tools/gh-phoenix/command.ts";
import {glossaryDriftCommand} from "./tools/glossary-drift/command.ts";
import {leakGuardCommand} from "./tools/leak-guard/command.ts";
import {mainSyncCommand} from "./tools/main-sync/command.ts";
import {mergeQueueClassifyCommand} from "./tools/merge-queue-classify/command.ts";
import {pathFilterGuardCommand} from "./tools/path-filter-guard/command.ts";
import {pointerGuardCommand} from "./tools/pointer-guard/command.ts";
import {reachabilityGuardCommand} from "./tools/reachability-guard/command.ts";
import {readmeGuardCommand} from "./tools/readme-guard/command.ts";
import {refGuardCommand} from "./tools/ref-guard/command.ts";
import {resumePolicyCommand} from "./tools/resume-policy/command.ts";
import {roadmapGuardCommand} from "./tools/roadmap-guard/command.ts";
import {settingsEnvGuardCommand} from "./tools/settings-env-guard/command.ts";
import {shipDigestCommand} from "./tools/ship-digest/command.ts";
import {spawnGuardCommand} from "./tools/spawn-guard/command.ts";
import {structuredOutputGuardCommand} from "./tools/structured-output-guard/command.ts";
import {tokenSpendCommand} from "./tools/token-spend/command.ts";
import {trivialDiffCommand} from "./tools/trivial-diff/command.ts";
import {verdictCommand} from "./tools/verdict/command.ts";
import {wayfinderMapCommand} from "./tools/wayfinder-map/command.ts";
import {workflowContractCommand} from "./tools/workflow-contract/command.ts";
import {worktreeGuardCommand} from "./tools/worktree-guard/command.ts";
import {worktreeSweepCommand} from "./tools/worktree-sweep/command.ts";
import {versionCommand} from "./version.ts";

/** The Node platform service union the bin provides — the requirement ceiling for a tool. */
type Platform = NodeServices.NodeServices;

/**
 * A registered pipeline tool: a top-level `effect/unstable/cli` `Command` whose
 * `name` is the `pipeline-cli <name>` selector.
 *
 * The requirement row is bounded by **the Node platform services** — the one
 * layer the bin provides at the run boundary (`bin.ts`). A tool that needs more
 * than the Node platform (a `Github` capability, a DB) must bake its own layer
 * into its `Command` with `Command.provide(...)` **before** registering, so the
 * registered command's residual requirement is the platform union. That keeps
 * the bin and the router core stable as tools fold in: a tool self-contains its
 * services, the bin never grows a per-tool layer. The `Name`/`Input`/
 * `ContextInput`/`E` slots are left at their widest so the registry stays
 * heterogeneous over tools with different names, args, flags, and error rows.
 * Both `Name` and `Input` are `any` because each sits in a contravariant slot
 * (`CommandContext<Name>`, `Variance<in Input, …>`): a concrete literal name
 * (`"version"`) is not assignable to `string`, and a tool's concrete input shape
 * (`{epic, dryRun}`) is not assignable from `object` — so only `any` admits tools
 * with different literal names and different arg/flag inputs into one registry array.
 */
export type RegisteredTool = Command.Command<any, any, object, unknown, Platform>;

/**
 * The registered pipeline tools, in the order they list under `--help`.
 *
 * Phase 1 ships the tracer tool only (`version`); Phase-2 children append their
 * moved tool's `Command` to this array — that single append is the entire
 * registration step (epic #994). The router and bin read this array opaquely, so
 * a new entry needs no edit anywhere else.
 */
export const registeredTools: ReadonlyArray<RegisteredTool> = [
	versionCommand,
	epicLedgerCommand,
	epicLockCommand,
	decisionsIndexCommand,
	readmeGuardCommand,
	roadmapGuardCommand,
	worktreeGuardCommand,
	spawnGuardCommand,
	leakGuardCommand,
	mergeQueueClassifyCommand,
	pathFilterGuardCommand,
	pointerGuardCommand,
	ciRequiredCommand,
	ghPhoenixCommand,
	crabboxManifestCommand,
	changelogDeriveCommand,
	structuredOutputGuardCommand,
	workflowContractCommand,
	worktreeSweepCommand,
	codeownersCpCommand,
	tokenSpendCommand,
	trivialDiffCommand,
	classProbeCommand,
	wayfinderMapCommand,
	shipDigestCommand,
	glossaryDriftCommand,
	failureClassifierCommand,
	fanoutGuardCommand,
	reachabilityGuardCommand,
	designTokenGuardCommand,
	resumePolicyCommand,
	evalHarnessCommand,
	mainSyncCommand,
	refGuardCommand,
	settingsEnvGuardCommand,
	verdictCommand,
	campaignCommand,
	catalogGuardCommand,
];
