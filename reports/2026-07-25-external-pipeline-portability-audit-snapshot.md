# Third-party portability audit — recovered snapshot (2026-07-25)

> **Read this first. Nothing below measures phoenix `main`, and nothing below describes this
> repository.**
>
> This is a **recovered snapshot of a document written by an out-of-org adopter**, `hueypov`, about
> **his own extracted copy** of the pipeline. He deleted it from that repository's HEAD; it survived
> only in that repository's git history, which is why it was pulled here while it was still
> reachable. Everything below the horizontal rule is his text, not ours.
>
> Three properties make it a **map to re-derive from, never a work list to build from**:
>
> 1. **It measures his tree, not ours.** Every number in it — files scanned, files flagged, each
>    per-category total — is a read of *his extracted copy* taken on 2026-07-25. None has been
>    re-derived against phoenix `main`, and none may be quoted as a fact about phoenix `main`.
> 2. **It reports file-level counts only. There are no line numbers anywhere in it.** Nothing in it
>    points at a specific site in any tree, so it cannot be turned directly into a patch list.
> 3. **It was already stale when it was deleted.** The author fixed parts of it himself in later
>    commits to the same repository. The snapshot is stale by construction — including relative to
>    the very repository it describes.
>
> Every claim here is a **quoted claim about someone else's tree** until it is re-derived against
> current phoenix `main` and filed on its own merits. That re-derivation is deliberately not part of
> this snapshot.

## Provenance

| Field | Value |
|---|---|
| Source repository | `hueypov/kampus-pipeline` — public, owned by a GitHub user account, not a GitHub fork |
| Source commit | `d4299968a7afb7257a828258ce97dd23abf65785` — "Document remaining Phoenix portability gaps", 2026-07-25T21:35:20Z, single-file, added `PORTABILITY_AUDIT.md` (+291 lines) |
| Source blob | `2e695430df5d9a61b35a044aa442d198b1dfcefd` |
| State at source HEAD | deleted — the file is absent from that repository's default branch |
| Recovered | 2026-07-27, from that repository's git object store |
| Recovered under | kamp-us/phoenix issue #4311 |

## Fidelity — what differs from the source blob

The body below is the source blob line-for-line, with **one** exception: on the line naming
`packages/pipeline-cli/src/registry.ts`, the inline markdown hyperlink was reduced to a plain code
span. That link was relative to the root of *his* repository, so as a link inside `reports/` here it
resolves to nothing and reds the repo-wide dead-link gate. The visible text is unchanged, and the
blob SHA above is enough to fetch the untouched original.

Headings, wording, emphasis, spelling, and every count are otherwise his and were not edited — not
even where they are wrong about this repository.

---

# Portability audit — remaining Phoenix coupling

**Audit date:** 2026-07-25  
**Scope:** every tracked text file in this repository, excluding `pnpm-lock.yaml`
and `node_modules`. The scan covered 516 tracked files.

## Result

The repository is **not yet a fully portable toolkit**. The scan found **134
files** with at least one Phoenix-specific or unported-workflow marker.

The recently completed bootstrap work is portable: the private submodule flow,
project-local `pipeline` script, generated `claude-plugins/` links, crew config
template, and generic `WorktreeCreate` hook have no Phoenix application
dependency. The remaining problem is the copied workflow payload and much of
`pipeline-cli`.

This document is an inventory, not a deletion plan. Some names such as
“control plane” are not inherently Phoenix-specific, but their current rules,
path classifiers, labels, and approval policy are. A file can appear in more
than one category.

## Scan markers and counts

| Marker family | Matching files | Meaning |
|---|---:|---|
| `phoenix` | 8 | Direct project identity remains in runtime code, test fixtures, and project documentation. |
| `apps/web` | 58 | Phoenix application-layout assumptions. |
| `cloudflare`, `cf-utils`, `flagship` | 17 | Phoenix release and feature-flag platform behavior. |
| `origin/main` or `origin main` | 39 | Hard-coded remote and default branch assumptions. |
| `lefthook` | 7 | Assumption of Phoenix’s Git hook runner. |
| `status:awaiting-release`, “agents deploy”, “humans release” | 5 | Phoenix release-cycle policy. |
| `control-plane` / `CONTROL_PLANE` | 60 | Current path, approval, and merge policy inherited from Phoenix. |
| `fate`, `alchemy`, `kunye`, `sozluk`, `çaylak`, `yazar` | 26 | Phoenix domain/application vocabulary. |
| `<related work item>`, “the adopting repository”, “repository-resolution rule” | 52 | Unfinished copied prose and source-repository policy references. |

## Severity 1 — executable blockers

These are active runtime paths. They must be removed, disabled, or redesigned
before this toolkit can be called generic.

### `pipeline-cli` exposes Phoenix-specific commands

`packages/pipeline-cli/src/registry.ts`
registers every command below for every adopting repository. The following
command families encode Phoenix paths, control-plane policy, feature flags, or
the `origin/main` convention:

- `catalog-guard`
- `class-probe`
- `codeowners-cp`
- `control-plane-paths`
- `cp-cardinality`
- `design-inventory`
- `design-token-guard`
- `fanout-guard`
- `glossary-drift`
- `main-sync`
- `patch-guard`
- `primary-index-guard`
- `reachability-guard`
- `ref-guard`
- `ship-digest`
- `trivial-diff`

The corresponding source directories contain real implementation, not merely
examples. In particular:

- `reachability-guard` hard-codes `apps/web/src/flags/keys.ts`, React `.tsx`
  consumers, and `apps/web/tests/e2e`.
- `design-token-guard` hard-codes the Phoenix CSS tree and token file.
- `fanout-guard`, `patch-guard`, `class-probe`, and `control-plane-paths`
  classify Phoenix application paths and policies.
- `ship-digest` reads Cloudflare Flagship release state.
- `main-sync`, `ref-guard`, `primary-index-guard`, and `worktree-sweep`
  assume `origin/main` and/or Lefthook behavior.

**Required action:** keep only tools whose inputs derive from the target
repository, or move these command families back to Phoenix. Do not leave them
registered merely because they are unused by the current bootstrap.

### Active skills still enforce Phoenix workflow policy

The following active skills contain application paths, Phoenix labels, feature
flag/release rules, control-plane rules, or a hard-coded default branch:

- `claude-plugins/kampus-pipeline/skills/adr/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/architecture-audit/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/campaign/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`
- `claude-plugins/kampus-pipeline/skills/heal-ci/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/plan-epic/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/report/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-code/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-design/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-doc/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-skill/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/review-trivial/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/triage/SKILL.md`
- `claude-plugins/kampus-pipeline/skills/write-code/SKILL.md`

The two cycle scripts are also Phoenix-only release policy:

- `claude-plugins/kampus-pipeline/skills/validate-cycle-absence.sh`
- `claude-plugins/kampus-pipeline/skills/validate-cycle-presence.sh`

`write-code` is especially important: despite the generic generated worktree
hook, its own fallback and repair instructions still use `origin/main`.

**Required action:** split generic Git/GitHub mechanics from the Phoenix issue
pipeline. The generic payload may derive an upstream/default branch from Git,
but may not prescribe `origin/main`, labels, a release queue, a feature-flag
system, a UI directory, a CI shape, or a control-plane approval rule.

### Active agent definitions still carry policy and path assumptions

The following are linked into an adopting repository’s `.claude/agents/` by
`pipeline init` and therefore are active consumer payload:

- `claude-plugins/kampus-pipeline/agents/adr.md`
- `claude-plugins/kampus-pipeline/agents/canon.md`
- `claude-plugins/kampus-pipeline/agents/coder.md`
- `claude-plugins/kampus-pipeline/agents/planner.md`
- `claude-plugins/kampus-pipeline/agents/reporter.md`
- `claude-plugins/kampus-pipeline/agents/reviewer.md`
- `claude-plugins/kampus-pipeline/agents/shipper.md`
- `claude-plugins/kampus-pipeline/agents/triager.md`

Most are wrappers around the skills above. `reviewer.md` and `shipper.md` also
repeat the control-plane, `apps/web`, and `origin/main` rules directly.

**Required action:** update agents only after their source skills are made
generic. Otherwise agents will continue to restate removed policy.

## Severity 2 — package and test contamination

These files are not all executed by consumers on a normal run, but they keep
Phoenix behavior compiled, tested, documented, and easy to re-enable.

### Phoenix-specific `pipeline-cli` source and tests

The complete matching `pipeline-cli` area is below. Source files and their
tests should be treated as one unit: retaining tests for a removed command
preserves Phoenix terminology; retaining a command without generic tests is
unsafe.

```text
packages/pipeline-cli/TOOLS.md
packages/pipeline-cli/src/tools/catalog-guard/{catalog-guard.ts,command.ts}
packages/pipeline-cli/src/tools/class-probe/{README.md,class-probe.ts,class-probe.unit.test.ts,command.ts}
packages/pipeline-cli/src/tools/codeowners-cp/{codeowners-cp.unit.test.ts,gate.test.ts,gate.ts}
packages/pipeline-cli/src/tools/control-plane-paths/{control-plane-paths.unit.test.ts,control-plane-re.ts}
packages/pipeline-cli/src/tools/design-inventory/{README.md,design-inventory.unit.test.ts}
packages/pipeline-cli/src/tools/design-token-guard/{README.md,command.ts,design-token-guard.ts,gate.ts,gate.unit.test.ts}
packages/pipeline-cli/src/tools/eval-harness/corpus/review-code.json
packages/pipeline-cli/src/tools/fanout-guard/{command.ts,fanout-guard.ts,fanout-guard.unit.test.ts,gate.ts}
packages/pipeline-cli/src/tools/glossary-drift/{drift.ts,drift.unit.test.ts}
packages/pipeline-cli/src/tools/leak-guard/{command.scan.test.ts,command.ts,crew-leak.ts,crew-leak.unit.test.ts,leak-guard.unit.test.ts,scan-pr.unit.test.ts}
packages/pipeline-cli/src/tools/main-sync/{command.ts,dep-refresh.unit.test.ts,main-sync.ts}
packages/pipeline-cli/src/tools/patch-guard/{gate.unit.test.ts,patch-guard.ts,patch-guard.unit.test.ts}
packages/pipeline-cli/src/tools/pointer-guard/{command.ts,gate.test.ts,gate.ts,pointer-guard.ts,pointer-guard.unit.test.ts}
packages/pipeline-cli/src/tools/primary-index-guard/{command.ts,primary-index-guard.ts,primary-index-guard.unit.test.ts}
packages/pipeline-cli/src/tools/reachability-guard/{command.ts,gate.ts,gate.unit.test.ts,reachability-guard.ts,reachability-guard.unit.test.ts}
packages/pipeline-cli/src/tools/redact-leaks/redact-leaks.unit.test.ts
packages/pipeline-cli/src/tools/ref-guard/{command.hook.test.ts,command.ts,ref-guard.ts,ref-guard.unit.test.ts}
packages/pipeline-cli/src/tools/roadmap/README.md
packages/pipeline-cli/src/tools/ship-digest/digest.ts
packages/pipeline-cli/src/tools/trivial-diff/{command.ts,trivial-diff.ts,trivial-diff.unit.test.ts}
packages/pipeline-cli/src/tools/unresolved-threads-guard/unresolved-threads-guard.unit.test.ts
packages/pipeline-cli/src/tools/verdict/verdict-match.unit.test.ts
packages/pipeline-cli/src/tools/wayfinder-map/{fixtures.ts,markdown.unit.test.ts}
packages/pipeline-cli/src/tools/worktree-guard/{bash-pin.unit.test.ts,clean-tree.unit.test.ts}
packages/pipeline-cli/src/tools/worktree-sweep/{command.hook.test.ts,command.ts,create-worktree.hook.test.ts,worktree-sweep.ts,worktree-sweep.unit.test.ts}
```

The public-npm README is also still present at
`packages/pipeline-cli/README.md`: it explicitly recommends public publishing
and global installation. This contradicts the private-submodule design.

### Crew package and payload

The core crew runtime is substantially more portable than `pipeline-cli`, but
it still contains copied policy and runtime-version prose:

- `packages/pipeline-crew-mcp/src/standup/config.ts` contains an installed
  Claude Code version and bundle-specific channel grammar rationale.
- `packages/pipeline-crew-mcp/src/standup/register-project-scope.ts` and
  `packages/pipeline-crew-mcp/src/standup/bind.test.ts` carry copied
  project-scope wording.
- `packages/pipeline-crew-mcp/src/crew/tracker.rendezvous.socket.test.ts`,
  `packages/pipeline-crew-mcp/src/tracker/rendezvous.{ts,test.ts}`, and
  `packages/pipeline-crew-mcp/src/tracker/rendezvous.test.ts` use Phoenix path
  fixtures.
- Crew documentation, the five crew agent definitions, and
  `crew.config.template.jsonc` still describe the old control-plane policy.

The channel reference grammar `plugin:<name>@<marketplace>` is **not** a
marketplace installation mechanism. It is Claude Code’s runtime channel syntax.
It should remain only if the current supported Claude Code runtime still needs
it; it does not justify restoring `.claude-plugin` manifests.

## Severity 3 — stale documentation and copied vocabulary

These files are primarily documentation debt, but they affect agents because
skills and agent definitions are prompt payload.

### Root and plugin docs

- `PROJECT.md` says copied documents may mention the older marketplace flow;
  that is no longer acceptable as canonical documentation.
- `README.md` and `claude-plugins/kampus-pipeline/README.md` retain copied
  wording such as “the adopting repository” and `origin/main`.
- `packages/pipeline-cli/README.md` and `packages/pipeline-cli/TOOLS.md`
  document public npm, global install, Phoenix tools, Lefthook, and
  application paths.
- `claude-plugins/pipeline-crew/{README.md,TUTORIAL.md,PERSONALIZATION.md,REFERENCE.md,EXPLANATION.md,HOW-TO.md}`
  retain the old control-plane model.

### Copied placeholder vocabulary

`<related work item>`, “the adopting repository”, and
“repository-resolution rule” are present across 52 files. They are not runtime
dependencies, but they show that source-specific prose was copied without being
made usable in a new repository.

Affected plugin locations include every remaining pipeline agent, the hook
scripts, and these skill documents:

```text
adr, architecture-audit, author-skill, campaign, deslop-comments, diataxis,
doctor, gh-issue-intake-formats, glossary, heal-ci, plan-epic, report,
review-code, review-design, review-doc, review-plan, review-skill,
review-trivial, ship-it, triage, wayfinder, write-code,
writing-clearly-and-concisely
```

`PROJECT.md`, `README.md`, `claude-plugins/kampus-pipeline/README.md`, and
the crew `README.md`, `TUTORIAL.md`, and `PERSONALIZATION.md` also match this
set.

## Direct Phoenix-name inventory

Only eight files use a literal `phoenix` string, but that low number is
misleading because most coupling is through paths and policy:

```text
PROJECT.md
claude-plugins/kampus-pipeline/skills/review-code/SKILL.md
packages/pipeline-cli/src/tools/eval-harness/corpus/review-code.json
packages/pipeline-cli/src/tools/leak-guard/crew-leak.ts
packages/pipeline-cli/src/tools/reachability-guard/gate.unit.test.ts
packages/pipeline-cli/src/tools/reachability-guard/reachability-guard.ts
packages/pipeline-cli/src/tools/reachability-guard/reachability-guard.unit.test.ts
packages/pipeline-cli/src/tools/unresolved-threads-guard/unresolved-threads-guard.unit.test.ts
```

## Existing audit is insufficient

`packages/pipeline/src/portable-audit.test.ts` checks only a narrow generated
payload subset. It does not inspect all skills, all agents, all of
`pipeline-cli`, the crew package, package documentation, or the root project
documents. It also contains examples of the very banned terms it searches for,
so it must be redesigned before it can become the full extraction guard.

## Recommended extraction order

1. **Define the portable CLI surface.** Keep only commands that derive all
   behavior from Git/GitHub/project configuration. Remove Phoenix command
   registrations and their source/tests, or explicitly move them back to the
   Phoenix repository.
2. **Remove Phoenix policy from generated payload.** Stop linking any skill or
   agent that remains dependent on Phoenix labels, paths, release policy, or
   control-plane policy.
3. **Make generic worktree behavior the single implementation.** Replace the
   remaining `origin/main` examples and fallback commands with upstream/default
   branch discovery.
4. **Rewrite, do not merely annotate, copied prompt documentation.** A prompt
   that tells an agent about `apps/web`, Flagship, or a specific team is active
   behavior even when it is Markdown.
5. **Finish the audit guard.** Scan all consumer-facing source, templates,
   docs, command registries, and tests. Exclude only vendored third-party files
   by explicit path. Make the test fail for prohibited runtime behavior rather
   than for a report that happens to mention it.

## Current conclusion

The toolkit bootstrap and generic worktree provisioning are ready to be reused.
The copied issue pipeline and most of `pipeline-cli` are still Phoenix payload.
They must be extracted out or redesigned before a non-Phoenix repository should
enable the full plugin set.
