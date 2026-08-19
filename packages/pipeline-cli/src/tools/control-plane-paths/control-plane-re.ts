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
 * The kampus-pipeline plugin clauses (skills/, lib/, agents/, hooks) retired with the plugin
 * itself (#5937 — one pipeline, fabrika; the tree is deleted, so the clauses classified paths
 * that can no longer exist). Fabrika's control-plane story is CODEOWNERS-direct (ADR 0135):
 * its ship gate reads `.github/CODEOWNERS`, not this regex.
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
 * The fabrika-cli clause (`^packages/fabrika-cli/src/ci/`) is the ONE §CP path in that package, and
 * the narrowness is the ruling, not an omission. `ci-required`'s verdict core — the pass/fail for the
 * single always-on required status context on `main` — is MOVING out of the pipeline-cli
 * `ci-required` tool and into `packages/fabrika-cli/src/ci/` via open child #6099 of epic #5720; on
 * `main` today `ci.yml` still runs the pipeline-cli bin, and the new dir does not exist yet. This
 * clause lands AHEAD of that move deliberately (founder's landing note on #6164), so the core
 * arrives already covered: without it, the day #6099 lands the covered path goes dead and the live
 * one is uncovered, a PR touching only the new dir matches no CODEOWNERS row, and with no `*`
 * catch-all and the ruleset at `required_approving_review_count: 0` + `require_code_owner_review:
 * true`, that merges at ZERO approvals. Under ADR 0187's enforcement test the core stays §CP
 * wherever it runs. The rest of `packages/fabrika-cli/` is ordinary by founder ruling on #6164 —
 * verbatim: "i'm ok with it as long as it's scoped to the ci checks, if not i trust fabrika enough
 * to self drive itself". Recorded in ADR 0299, extending ADR 0218's enforcement-core shape to
 * fabrika-cli.
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
 * The second prose copy (the `CONTROL_PLANE_RE=` line in the v1 formats doc, which the v1
 * gates re-resolved from `origin/main`; #981/#2761) retired with the kampus-pipeline plugin
 * (#5937) — this const and `.github/CODEOWNERS` are the two surfaces left, and
 * `codeowners-cp check` holds them in sync.
 */
export const CONTROL_PLANE_RE =
	"^(\\.claude|\\.github)/|^\\.claude-plugin/|^packages/ci-required/|^packages/fabrika-cli/src/ci/|^packages/pipeline-cli/src/[^/]+$|^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/|^packages/pipeline-cli/src/tools/tracker/gh-io\\.ts$|^biome\\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\\.lefthook)[^/]+$";
