/**
 * The pipeline-cli tool registry — the extension seam (epic #994).
 *
 * Each entry is one pipeline tool exposed as `pipeline-cli <name> …`. A child folds
 * its tool in by authoring an `effect/unstable/cli` `Command` and appending one
 * `tool(<name>, () => import(<module>))` row to `registeredTools` here — it never
 * reshapes the router core (`router.ts`) or the bin (`bin.ts`), both of which consume
 * this array opaquely.
 *
 * That is the whole contract of the seam: the router is closed for modification and
 * the registry is open for extension. A tool's subcommand surface (its own args/flags)
 * lives on the `Command` it registers, not here.
 *
 * Registration is **lazy** — see `tool-registration.ts` for why (#4008). Two rules follow
 * for anyone adding a row: `import()` with a **string-literal** specifier
 * (`rewriteRelativeImportExtensions` rewrites those on build, a computed one it cannot),
 * and give the row the **same name** the module's `Command.make("<name>")` declares —
 * `loadRegistration` asserts it.
 */
import {type ToolRegistration, tool} from "./tool-registration.ts";

export type {RegisteredTool} from "./tool-registration.ts";

/**
 * The registered pipeline tools, in the order they list under `--help`.
 */
export const registeredTools: ReadonlyArray<ToolRegistration> = [
	tool("version", () => import("./version.ts").then((m) => m.versionCommand)),
	tool("epic-ledger", () =>
		import("./tools/epic-ledger/command.ts").then((m) => m.epicLedgerCommand),
	),
	tool("epic-lock", () => import("./tools/epic-lock/command.ts").then((m) => m.epicLockCommand)),
	tool("epic-splice", () =>
		import("./tools/epic-splice/command.ts").then((m) => m.epicSpliceCommand),
	),
	tool("decisions-index", () =>
		import("./tools/decisions-index/command.ts").then((m) => m.decisionsIndexCommand),
	),
	tool("readme-guard", () =>
		import("./tools/readme-guard/command.ts").then((m) => m.readmeGuardCommand),
	),
	tool("roadmap", () => import("./tools/roadmap/command.ts").then((m) => m.roadmapCommand)),
	tool("roadmap-guard", () =>
		import("./tools/roadmap-guard/command.ts").then((m) => m.roadmapGuardCommand),
	),
	tool("worktree-guard", () =>
		import("./tools/worktree-guard/command.ts").then((m) => m.worktreeGuardCommand),
	),
	tool("spawn-guard", () =>
		import("./tools/spawn-guard/command.ts").then((m) => m.spawnGuardCommand),
	),
	tool("leak-guard", () => import("./tools/leak-guard/command.ts").then((m) => m.leakGuardCommand)),
	tool("merge-queue-classify", () =>
		import("./tools/merge-queue-classify/command.ts").then((m) => m.mergeQueueClassifyCommand),
	),
	// #3723 — ship-it's no-parked-merge-intent enforcement (ADR 0198): clears a `gh pr merge
	// --auto` request left armed by a run that did NOT enqueue, so a later bare approval can't
	// enqueue a §CP PR ahead of the gate assertions. Verified by an `auto_merge` read-back.
	tool("merge-intent", () =>
		import("./tools/merge-intent/command.ts").then((m) => m.mergeIntentCommand),
	),
	tool("path-filter-guard", () =>
		import("./tools/path-filter-guard/command.ts").then((m) => m.pathFilterGuardCommand),
	),
	tool("pointer-guard", () =>
		import("./tools/pointer-guard/command.ts").then((m) => m.pointerGuardCommand),
	),
	tool("ci-required", () =>
		import("./tools/ci-required/command.ts").then((m) => m.ciRequiredCommand),
	),
	tool("gh-phoenix", () => import("./tools/gh-phoenix/command.ts").then((m) => m.ghPhoenixCommand)),
	tool("crabbox-manifest", () =>
		import("./tools/crabbox-manifest/command.ts").then((m) => m.crabboxManifestCommand),
	),
	tool("changelog-derive", () =>
		import("./tools/changelog-derive/command.ts").then((m) => m.changelogDeriveCommand),
	),
	tool("structured-output-guard", () =>
		import("./tools/structured-output-guard/command.ts").then(
			(m) => m.structuredOutputGuardCommand,
		),
	),
	tool("workflow-contract", () =>
		import("./tools/workflow-contract/command.ts").then((m) => m.workflowContractCommand),
	),
	tool("worktree-sweep", () =>
		import("./tools/worktree-sweep/command.ts").then((m) => m.worktreeSweepCommand),
	),
	tool("worktree-reap", () =>
		import("./tools/worktree-reap/command.ts").then((m) => m.worktreeReapCommand),
	),
	tool("codeowners-cp", () =>
		import("./tools/codeowners-cp/command.ts").then((m) => m.codeownersCpCommand),
	),
	tool("control-plane-paths", () =>
		import("./tools/control-plane-paths/command.ts").then((m) => m.controlPlanePathsCommand),
	),
	tool("cp-classify", () =>
		import("./tools/cp-classify/command.ts").then((m) => m.cpClassifyCommand),
	),
	tool("cp-cardinality", () =>
		import("./tools/cp-cardinality/command.ts").then((m) => m.cpCardinalityCommand),
	),
	// #4292 — the §CP approval-watcher's durable tick record: the loop's only trace outside the
	// running agent's transcript, so "the loop never ticked" and "it ticked and found nothing"
	// stop being the same observation.
	tool("approval-watcher", () =>
		import("./tools/approval-watcher/command.ts").then((m) => m.approvalWatcherCommand),
	),
	// #4754 — banking a §CP PR is one act that writes the label the watch set is derived from, and
	// `check` is the outside reader that reds when that set is banked with no watcher ticking.
	tool("cp-bank", () => import("./tools/cp-bank/command.ts").then((m) => m.cpBankCommand)),
	tool("token-spend", () =>
		import("./tools/token-spend/command.ts").then((m) => m.tokenSpendCommand),
	),
	tool("tracker", () => import("./tools/tracker/command.ts").then((m) => m.trackerCommand)),
	tool("trivial-diff", () =>
		import("./tools/trivial-diff/command.ts").then((m) => m.trivialDiffCommand),
	),
	tool("tsc-annotate", () =>
		import("./tools/tsc-annotate/command.ts").then((m) => m.tscAnnotateCommand),
	),
	tool("class-probe", () =>
		import("./tools/class-probe/command.ts").then((m) => m.classProbeCommand),
	),
	tool("wayfinder-map", () =>
		import("./tools/wayfinder-map/command.ts").then((m) => m.wayfinderMapCommand),
	),
	tool("ship-digest", () =>
		import("./tools/ship-digest/command.ts").then((m) => m.shipDigestCommand),
	),
	tool("glossary-drift", () =>
		import("./tools/glossary-drift/command.ts").then((m) => m.glossaryDriftCommand),
	),
	tool("guard-content-probe", () =>
		import("./tools/guard-content-probe/command.ts").then((m) => m.guardContentProbeCommand),
	),
	tool("failure-classifier", () =>
		import("./tools/failure-classifier/command.ts").then((m) => m.failureClassifierCommand),
	),
	tool("fanout-guard", () =>
		import("./tools/fanout-guard/command.ts").then((m) => m.fanoutGuardCommand),
	),
	tool("reachability-guard", () =>
		import("./tools/reachability-guard/command.ts").then((m) => m.reachabilityGuardCommand),
	),
	tool("design-token-guard", () =>
		import("./tools/design-token-guard/command.ts").then((m) => m.designTokenGuardCommand),
	),
	tool("design-inventory", () =>
		import("./tools/design-inventory/command.ts").then((m) => m.designInventoryCommand),
	),
	tool("resume-policy", () =>
		import("./tools/resume-policy/command.ts").then((m) => m.resumePolicyCommand),
	),
	// The shared PR-head-checkout the review gates cite instead of hand-copying the §HEAD
	// materialization (#793 / #1807): resolve + fetch the PR's current head into a per-run ref
	// (+ optional detached worktree), asserting the fetched ref IS the resolved head (ADR 0058).
	tool("review-head", () =>
		import("./tools/review-head/command.ts").then((m) => m.reviewHeadCommand),
	),
	tool("main-sync", () => import("./tools/main-sync/command.ts").then((m) => m.mainSyncCommand)),
	tool("ref-guard", () => import("./tools/ref-guard/command.ts").then((m) => m.refGuardCommand)),
	tool("verified-push", () =>
		import("./tools/verified-push/command.ts").then((m) => m.verifiedPushCommand),
	),
	tool("primary-index-guard", () =>
		import("./tools/primary-index-guard/command.ts").then((m) => m.primaryIndexGuardCommand),
	),
	tool("settings-env-guard", () =>
		import("./tools/settings-env-guard/command.ts").then((m) => m.settingsEnvGuardCommand),
	),
	tool("verdict", () => import("./tools/verdict/command.ts").then((m) => m.verdictCommand)),
	tool("campaign", () => import("./tools/campaign/command.ts").then((m) => m.campaignCommand)),
	tool("catalog-guard", () =>
		import("./tools/catalog-guard/command.ts").then((m) => m.catalogGuardCommand),
	),
	tool("change-detect-guard", () =>
		import("./tools/change-detect-guard/command.ts").then((m) => m.changeDetectGuardCommand),
	),
	tool("patch-guard", () =>
		import("./tools/patch-guard/command.ts").then((m) => m.patchGuardCommand),
	),
	tool("intake-dedup", () =>
		import("./tools/intake-dedup/command.ts").then((m) => m.intakeDedupCommand),
	),
	// The #3688 intake-body composer (epic #3258): one tested verb that emits the
	// format-2 sub-issue body of the gh-issue-intake-formats.md prose contract, so a
	// filer cites it instead of re-deriving the format — and owns the by-value handoff
	// that keeps the `-f body=@file` leak class (#2002 / #754) unreachable.
	tool("intake-compose", () =>
		import("./tools/intake-compose/command.ts").then((m) => m.intakeComposeCommand),
	),
	tool("split-guard", () =>
		import("./tools/split-guard/command.ts").then((m) => m.splitGuardCommand),
	),
	tool("redact-leaks", () =>
		import("./tools/redact-leaks/command.ts").then((m) => m.redactLeaksCommand),
	),
	tool("commands", () => import("./tools/commands/command.ts").then((m) => m.commandsCommand)),
	// The ADR-0158 unresolved-inline-thread merge gate's fail-closed enforcement (#3331):
	// reds a PR when a substantive unresolved review thread is unaccounted-for in the
	// review-code verdict, covering the §CP manual-merge path ship-it Step 3.6 never sees.
	tool("unresolved-threads-guard", () =>
		import("./tools/unresolved-threads-guard/command.ts").then(
			(m) => m.unresolvedThreadsGuardCommand,
		),
	),
	// The #3687 issue-scoped claim resolver (epic #3258 verb wave): resolves the ADR-0115
	// earliest-authorized-claim decision — "is this claim mine?" — default-deny, reusing
	// epic-lock's pure `resolveClaim` core rather than a second copy.
	tool("claim", () => import("./tools/claim/command.ts").then((m) => m.claimCommand)),
	// The #3254 adoption corpus-lint (epic #3258, governing AC): reds a corpus file that
	// inline-re-derives a tool-owned decision without citing the owning verb, so the verb
	// sweep can't grow the unreferenced-tool pile. Fail-closed on zero scope (ADR 0092).
	tool("adoption-lint", () =>
		import("./tools/adoption-lint/command.ts").then((m) => m.adoptionLintCommand),
	),
	// #3314 — reds on a bare `pipeline-cli <verb>` in a runnable fence. The CLI is not on PATH
	// where agents spawn and won't be (ADR 0207), so a bare call dies `command not found` inside a
	// fail-closed gate wrapper, which launders the miss into a wrong verdict. Enforces §CLI.
	tool("cli-invocation-guard", () =>
		import("./tools/cli-invocation-guard/command.ts").then((m) => m.cliInvocationGuardCommand),
	),
	// #4479 — reds on `errexit` + an `EXIT` trap in one runnable shell unit: on bash 3.2 a `set -u`
	// abort then reaches the trap with `$?` already 0, so a cleanup trap exits 0 and the guard
	// reports success on a path it never evaluated. Fail-closed on zero scope, per surface.
	tool("trap-status-guard", () =>
		import("./tools/trap-status-guard/command.ts").then((m) => m.trapStatusGuardCommand),
	),
	// #3650 — the orphan-red-PR detector + heal-item emitter (the #3532 boundary path, steps
	// 1–2): convert an open, CI-red, laneless PR into one idempotent triaged "heal red CI on
	// PR #N" item so an engine adopts the lane, rather than free-scanning arbitrary red PRs.
	tool("orphan-heal", () =>
		import("./tools/orphan-heal/command.ts").then((m) => m.orphanHealCommand),
	),
	// #3762 — the shared head-CI read: roll a SHA's check-runs up LATEST-PER-CONTEXT, so a
	// superseded run can't red a green head (the false RED that opened a needless repair lane
	// on PR #3733). The one tested reader every CI-state consumer cites instead of re-rolling
	// the query, the single-source shape of `verdict read` (#3686).
	tool("checks", () => import("./tools/checks/command.ts").then((m) => m.checksCommand)),
	// #3833 — ADR 0201 §3's isolated-publishing invariant: reds when a package the
	// release pipeline (publish.yml) ships links a private/unpublished @kampus dep or a
	// workspace: specifier, making the #3802 uninstallable-publish class unrepresentable.
	// Scope derived from publish.yml's tag grammar; fail-closed on zero scope (ADR 0092).
	tool("publish-isolation-guard", () =>
		import("./tools/publish-isolation-guard/command.ts").then(
			(m) => m.publishIsolationGuardCommand,
		),
	),
	// #3991 — the SHA-bound run-evidence bundle lookup as FOUR states: present / pending / absent /
	// unknown. review-code's inline `gh api` chain collapsed every non-success path into the prose
	// "absent for this head SHA", so a producer that had not run yet and a 5xx during the download
	// both read as a missing bundle. Validates the archive (ZIP magic) and the manifest
	// (schemaVersion, commit == head) before interpreting either, and carries the lookup evidence
	// (queried SHA, run id, artifact id) so the claim is falsifiable from the verdict comment alone.
	tool("run-evidence", () =>
		import("./tools/run-evidence/command.ts").then((m) => m.runEvidenceCommand),
	),
	// #3939 — the teeth behind the triage rubric's home-or-exempt-or-kill outcome (ADR 0202
	// forward-motion doctrine, ADR 0208 standing-lane exemption): reds when an issue leaves
	// triage with neither an arc/campaign milestone nor one of the two standing-lane labels,
	// so floaters can't regrow at the seam. Fail-closed on zero scope (ADR 0092).
	tool("homing-guard", () =>
		import("./tools/homing-guard/command.ts").then((m) => m.homingGuardCommand),
	),
	// #3963 — the teeth behind the pitch requirement (founder ruling #3909, contract §PITCH):
	// reds when lane-entering work is pickable without a well-formed, FOUNDER-approved pitch, so
	// the format cannot land advisory-only. Approval is a founder seat — an agent-provenance-
	// stamped marker never satisfies it. Fail-closed on zero scope (ADR 0092), and intake-only:
	// the same ruling forbids any merge-blocking direction gate on shipped work.
	tool("pitch-guard", () =>
		import("./tools/pitch-guard/command.ts").then((m) => m.pitchGuardCommand),
	),
	// #4272 — the adopting-repo prerequisite check: the label taxonomy and ROADMAP.md are hard
	// dependencies of every tool above, not defaults, and a repo without them got no error because
	// every scan simply matched nothing. Names each missing label instead. Deliberately an
	// assertion, not a config seam — the vocabulary is governance, and widening it is a founder call.
	tool("vocabulary-preflight", () =>
		import("./tools/vocabulary-preflight/command.ts").then((m) => m.vocabularyPreflightCommand),
	),
	// #3980 — the mechanical half of the ADR contradiction sweep: rank the live-accepted ADRs a
	// new ADR touches the decision domain of but never cites, so a same-question conflict with an
	// unsuperseded ADR (0208-vs-0072, 0210-vs-0202) is a list to clear rather than a memory test.
	// Fail-closed on an unreadable corpus / zero scope (ADR 0092); `indeterminate` is a distinct
	// outcome from `no-overlap` by construction.
	tool("adr-sweep", () => import("./tools/adr-sweep/command.ts").then((m) => m.adrSweepCommand)),
	// #3718 — the per-run scratch namespace (§SP) as an allocator every agent calls instead
	// of hand-rolling a path: unique per RUN, deterministically re-derivable across Bash
	// calls, owner-stamped so a second run is refused rather than clobbering. Fail-closed —
	// no fallback to a shared location, which is what made the collision silent.
	tool("scratchpad", () =>
		import("./tools/scratchpad/command.ts").then((m) => m.scratchpadCommand),
	),
	// #3964 — lane accounting the factory never had: the unlanded build-lane set computed off
	// GitHub (claim markers + open PRs) instead of self-reported by an engine, classified
	// platform vs product against the founder-set 6-lane capacity / 2-lane quota. A self-report
	// is neither verifiable nor attributable, which is how a wrong lane number reached a
	// capacity decision. Read-only; the quota enforcement is #3965.
	tool("lane", () => import("./tools/lane/command.ts").then((m) => m.laneCommand)),
];
