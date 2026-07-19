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
import {adoptionLintCommand} from "./tools/adoption-lint/command.ts";
import {campaignCommand} from "./tools/campaign/command.ts";
import {catalogGuardCommand} from "./tools/catalog-guard/command.ts";
import {changeDetectGuardCommand} from "./tools/change-detect-guard/command.ts";
import {changelogDeriveCommand} from "./tools/changelog-derive/command.ts";
import {ciRequiredCommand} from "./tools/ci-required/command.ts";
import {claimCommand} from "./tools/claim/command.ts";
import {classProbeCommand} from "./tools/class-probe/command.ts";
import {codeownersCpCommand} from "./tools/codeowners-cp/command.ts";
import {commandsCommand} from "./tools/commands/command.ts";
import {controlPlanePathsCommand} from "./tools/control-plane-paths/command.ts";
import {cpCardinalityCommand} from "./tools/cp-cardinality/command.ts";
import {crabboxManifestCommand} from "./tools/crabbox-manifest/command.ts";
import {crewFanoutGuardCommand} from "./tools/crew-fanout-guard/command.ts";
import {decisionsIndexCommand} from "./tools/decisions-index/command.ts";
import {designInventoryCommand} from "./tools/design-inventory/command.ts";
import {designTokenGuardCommand} from "./tools/design-token-guard/command.ts";
import {epicLedgerCommand} from "./tools/epic-ledger/command.ts";
import {epicLockCommand} from "./tools/epic-lock/command.ts";
import {epicSpliceCommand} from "./tools/epic-splice/command.ts";
import {evalHarnessCommand} from "./tools/eval-harness/command.ts";
import {failureClassifierCommand} from "./tools/failure-classifier/command.ts";
import {fanoutGuardCommand} from "./tools/fanout-guard/command.ts";
import {ghPhoenixCommand} from "./tools/gh-phoenix/command.ts";
import {glossaryDriftCommand} from "./tools/glossary-drift/command.ts";
import {guardContentProbeCommand} from "./tools/guard-content-probe/command.ts";
import {intakeComposeCommand} from "./tools/intake-compose/command.ts";
import {intakeDedupCommand} from "./tools/intake-dedup/command.ts";
import {leakGuardCommand} from "./tools/leak-guard/command.ts";
import {mainSyncCommand} from "./tools/main-sync/command.ts";
import {mergeQueueClassifyCommand} from "./tools/merge-queue-classify/command.ts";
import {orphanHealCommand} from "./tools/orphan-heal/command.ts";
import {patchGuardCommand} from "./tools/patch-guard/command.ts";
import {pathFilterGuardCommand} from "./tools/path-filter-guard/command.ts";
import {pointerGuardCommand} from "./tools/pointer-guard/command.ts";
import {primaryIndexGuardCommand} from "./tools/primary-index-guard/command.ts";
import {reachabilityGuardCommand} from "./tools/reachability-guard/command.ts";
import {readmeGuardCommand} from "./tools/readme-guard/command.ts";
import {redactLeaksCommand} from "./tools/redact-leaks/command.ts";
import {refGuardCommand} from "./tools/ref-guard/command.ts";
import {resumePolicyCommand} from "./tools/resume-policy/command.ts";
import {reviewHeadCommand} from "./tools/review-head/command.ts";
import {roadmapCommand} from "./tools/roadmap/command.ts";
import {roadmapGuardCommand} from "./tools/roadmap-guard/command.ts";
import {settingsEnvGuardCommand} from "./tools/settings-env-guard/command.ts";
import {shipDigestCommand} from "./tools/ship-digest/command.ts";
import {spawnGuardCommand} from "./tools/spawn-guard/command.ts";
import {splitGuardCommand} from "./tools/split-guard/command.ts";
import {structuredOutputGuardCommand} from "./tools/structured-output-guard/command.ts";
import {tokenSpendCommand} from "./tools/token-spend/command.ts";
import {trackerCommand} from "./tools/tracker/command.ts";
import {trivialDiffCommand} from "./tools/trivial-diff/command.ts";
import {unresolvedThreadsGuardCommand} from "./tools/unresolved-threads-guard/command.ts";
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
	epicSpliceCommand,
	decisionsIndexCommand,
	readmeGuardCommand,
	roadmapCommand,
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
	controlPlanePathsCommand,
	cpCardinalityCommand,
	tokenSpendCommand,
	trackerCommand,
	trivialDiffCommand,
	classProbeCommand,
	wayfinderMapCommand,
	shipDigestCommand,
	glossaryDriftCommand,
	guardContentProbeCommand,
	failureClassifierCommand,
	fanoutGuardCommand,
	reachabilityGuardCommand,
	designTokenGuardCommand,
	designInventoryCommand,
	resumePolicyCommand,
	// The shared PR-head-checkout the review gates cite instead of hand-copying the §HEAD
	// materialization (#793 / #1807): resolve + fetch the PR's current head into a per-run ref
	// (+ optional detached worktree), asserting the fetched ref IS the resolved head (ADR 0058).
	reviewHeadCommand,
	evalHarnessCommand,
	mainSyncCommand,
	refGuardCommand,
	primaryIndexGuardCommand,
	settingsEnvGuardCommand,
	verdictCommand,
	campaignCommand,
	catalogGuardCommand,
	changeDetectGuardCommand,
	patchGuardCommand,
	intakeDedupCommand,
	// The #3688 intake-body composer (epic #3258): one tested verb that emits the
	// format-2 sub-issue body of the gh-issue-intake-formats.md prose contract, so a
	// filer cites it instead of re-deriving the format — and owns the by-value handoff
	// that keeps the `-f body=@file` leak class (#2002 / #754) unreachable.
	intakeComposeCommand,
	splitGuardCommand,
	redactLeaksCommand,
	commandsCommand,
	// The ADR-0158 unresolved-inline-thread merge gate's fail-closed enforcement (#3331):
	// reds a PR when a substantive unresolved review thread is unaccounted-for in the
	// review-code verdict, covering the §CP manual-merge path ship-it Step 3.6 never sees.
	unresolvedThreadsGuardCommand,
	// The #3687 issue-scoped claim resolver (epic #3258 verb wave): resolves the ADR-0115
	// earliest-authorized-claim decision — "is this claim mine?" — default-deny, reusing
	// epic-lock's pure `resolveClaim` core rather than a second copy.
	claimCommand,
	// The #3254 adoption corpus-lint (epic #3258, governing AC): reds a corpus file that
	// inline-re-derives a tool-owned decision without citing the owning verb, so the verb
	// sweep can't grow the unreferenced-tool pile. Fail-closed on zero scope (ADR 0092).
	adoptionLintCommand,
	// #3606 — inverts the crew read-only-fanout per-bridge spawn denylist into an ENFORCED
	// allowlist: reds when a mutating roster agent-type is neither allowlisted nor denied by a
	// crew bridge (chief-of-staff/cartographer/intake-desk), closing the future-agent hole ADR
	// 0196 warns of. Fail-closed on zero scope (ADR 0092); roster-law boundary (ADR 0189/0196).
	crewFanoutGuardCommand,
	// #3650 — the orphan-red-PR detector + heal-item emitter (the #3532 boundary path, steps
	// 1–2): convert an open, CI-red, laneless PR into one idempotent triaged "heal red CI on
	// PR #N" item so an engine adopts the lane, rather than free-scanning arbitrary red PRs.
	orphanHealCommand,
];
