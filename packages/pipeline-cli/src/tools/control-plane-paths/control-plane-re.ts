/**
 * The §CP control-plane boundary — the SINGLE source of truth (issue #2761).
 *
 * `CONTROL_PLANE_RE` is the one anchored regex that classifies which paths are
 * control-plane (human-merge-only, ADR 0053/0065/0073 §6/0100/0103/0150/0174). It
 * used to be hand-copied into ~10 live surfaces (5 gate skills, the formats-doc prose,
 * `codeowners-cp.ts`, and 3 vitest fixtures), guarded only by a byte-compare drift
 * check that missed the fixtures — so a stale fixture assertion ran only in
 * `merge_group` and silently ejected 3 green PRs (#2673). This const makes that
 * whole class unrepresentable: everything importable IMPORTS this, and the two
 * un-importable prose surfaces (the formats-doc `CONTROL_PLANE_RE=` line the live
 * gates read from `origin/main`, and `.github/CODEOWNERS`) are drift-guarded against
 * it — one definition, no copies.
 *
 * The runtime value (what `pipeline-cli control-plane-paths` prints) is the POSIX-ERE
 * grep/jq form the gates match against; the doubled backslashes here are TS string
 * escapes, so `\\.` is the value `\.` and `([^/]+/)*[^/]+\\.sh$` is the value
 * `([^/]+/)*[^/]+\.sh$`.
 *
 * The skills clause is the WHOLE TREE — `^claude-plugins/kampus-pipeline/skills/`, every file
 * at any depth regardless of extension (founder ruling on #4446, implemented by #4458). It
 * replaces three narrower branches that between them left a proven zero-approval hole: an
 * ENUMERATED list of gate-skill dirs, a `([^/]+/)*[^/]+\.sh$` any-depth `.sh` clause, and an
 * exact-file clause for `gh-issue-intake-formats.md`. Because `.github/CODEOWNERS` has no `*`
 * catch-all and the `main` ruleset pairs `required_approving_review_count: 0` with
 * `require_code_owner_review: true`, a path matching NO row merges with ZERO approvals — so a
 * non-`.sh` file beside a gated script (a `README.md`, a `.env`, an extensionless helper, a
 * relocated `.md`) was proven-ordinary and auto-mergeable. The DIRECTORY is now the unit of
 * coverage, not the file type: the enumeration cannot rot as skills are added, and no naming
 * convention has to hold for the tree to stay gated. The approval-load cost — the four
 * previously-excluded operational skill dirs (`heal-ci`, `what-shipped`, `doctor`, `wayfinder`)
 * are now §CP too — was stated to the founder and accepted.
 *
 * The `lib/` clause (`^claude-plugins/kampus-pipeline/lib/`) carries the skills clause's coverage
 * to the shared shell library's new home. `shared/` was never a skill — it survived inside
 * `skills/` only because `validate-skills.sh` enumerates skills via a per-directory SKILL.md glob
 * that skips it — so #4484 moved `common.sh` out to the ordinary `bin/` + `lib/` layout. Outside
 * the skills tree the destination is proven-ordinary (zero required approvals), and this file is
 * what every extracted
 * per-skill script sources: relocating it without this branch would strip the human merge gate
 * from the highest-leverage edit surface in the extraction programme. Move and branch are atomic
 * by construction, one commit, the #4462 discipline.
 *
 * The biome-governance clauses (`^biome\.jsonc$`, `^biome-plugins/`) are §CP because
 * lint/GritQL governance config is a guard-relaxing vector: an ungated path to weaken a
 * lint rule (disable a security lint, downgrade a GritQL guard) could pass the enforcement
 * test of ADR 0187 — merging it unreviewed CAN weaken a gate. Same class of decision as
 * ADR 0187's enforcement-surface test; recorded in ADR 0193.
 *
 * The lefthook clause (`^([^/]+/)*(lefthook|\\.lefthook)[^/]+$`) is §CP because that config is
 * what WIRES the local git hooks — the ADR-0160 ref-guard (#2143) and the #2778 primary-index
 * guards, which have no CI backstop and are the only defense of the shared local checkout against
 * a proven-real corruption class. An edit that silently unwires them must not auto-ship (founder
 * ruling on #3402). It is a SHAPE, not a named list (#2393): a depth-agnostic `([^/]+/)*` prefix
 * over the `lefthook` / `.lefthook` stem, so every
 * config filename lefthook itself discovers — `lefthook.yml`, the `.yaml`/`.toml`/`.json` forms, the
 * `lefthook-local.*` override, and the `.lefthookrc` the generated wrappers source — is covered
 * without enumerating any of them. The stem-plus-`[^/]+` leaf is what keeps it narrow: it matches
 * lefthook-named LEAVES only, so nothing else at the repo root is swept in.
 *
 * The marketplace-manifest clause (`^\.claude-plugin/`) needs its OWN branch because the
 * `^(\.claude|\.github)/` branch requires a literal `/` after `.claude` — the character after
 * `.claude` in `.claude-plugin/` is a hyphen, so that branch never matched it. Anchored to the
 * ROOT dir on purpose: an un-anchored `(^|/)\.claude-plugin/` would also sweep in every nested
 * plugin's own `plugin.json`, which a live founder ruling deliberately keeps OUT of §CP (#3765).
 * See ADR 0212.
 *
 * The pipeline-cli clauses cover an **enforcement core**, not the whole package (ADR 0218,
 * amending ADR 0100). Three branches:
 *
 *   - `^packages/pipeline-cli/src/[^/]+$` — the package's `src/` ROOT, non-recursive. This is the
 *     shared dispatch + process plumbing every tool including every gate runs through
 *     (`registry.ts`, `router.ts`, `bin.ts`, `gate-fail.ts`, `read-stdin*.ts`, `run.ts`,
 *     `tool-registration.ts`, `module-load-guard.ts`, `annotate.ts`, `find-root-dir.ts`,
 *     `version.ts`). Expressed as a non-recursive pattern rather than a file list so it cannot rot
 *     as root modules are added — the four-file list this replaced already lagged reality.
 *   - `^packages/pipeline-cli/src/tools/(…)/` — the eight tools that ARE the enforcement surface:
 *     `ci-required` (a branch-protection-required check), `verdict` (the enqueue gate),
 *     `cp-cardinality` (§CP approval discharge), `control-plane-paths` (this boundary),
 *     `cp-classify` (the §CP verdict), `codeowners-cp` (the regex↔CODEOWNERS drift gate),
 *     `trivial-diff` (routes to the lighter gate), `review-head` (the head every verdict binds to).
 *   - `^packages/pipeline-cli/src/tools/tracker/gh-io\.ts$` — ONE file, not its directory.
 *     `gh-io.ts` exports `authorizedAuthors`, the ADR-0055 write+ ACL whose result
 *     `verdict/github.ts` feeds straight into `resolveVerdict` — so widening it to return every
 *     author would let a FORGED verdict from a non-collaborator count as a PASS. Retaining the
 *     verdict resolver while leaving its authorization source ungated is an incoherent line. The
 *     rest of `tools/tracker/` is claim/coordination tooling and stays out, hence the file-level
 *     anchor rather than a directory prefix.
 *
 * Everything else under the package — coordination and read tooling — gates nothing and leaves §CP
 * per ADR 0187's enforcement-surface test. The trade is recorded in ADR 0218, including the three
 * modules the core imports without retaining, which `core-import-closure.unit.test.ts` pins.
 *
 * Anti-self-authorization is preserved (#981): the live merge-deciding gates still
 * re-resolve the boundary from the formats doc on `origin/main` at run time, so a
 * boundary-editing PR is classified against MAIN's boundary, not its own edit. This
 * const is the source the formats-doc line is kept in sync WITH — it does not move the
 * runtime resolution off the origin/main read.
 */
export const CONTROL_PLANE_RE =
	"^(\\.claude|\\.github)/|^\\.claude-plugin/|^claude-plugins/kampus-pipeline/skills/|^claude-plugins/kampus-pipeline/lib/|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/src/[^/]+$|^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/|^packages/pipeline-cli/src/tools/tracker/gh-io\\.ts$|^biome\\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\\.lefthook)[^/]+$";
