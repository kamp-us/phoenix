import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

// The boundary as the live gates apply it: a POSIX-ERE `grep -Eq`, here a RegExp over the
// same const string (every branch is `^`-anchored, so `.test` is prefix-anchored per branch).
const isControlPlane = (path: string): boolean => new RegExp(CONTROL_PLANE_RE).test(path);

describe("CONTROL_PLANE_RE classifies the ADR-0174 boundary broadenings (#2761)", () => {
	it("classifies the NEW §CP paths as control-plane", () => {
		// bare gate-critical `.sh` guard directly under skills/ (#2576)
		expect(
			isControlPlane("claude-plugins/kampus-pipeline/skills/validate-gate-path-drift.sh"),
		).toBe(true);
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/validate-skills.sh")).toBe(true);
		// the release + review-trivial skill dirs (#2679) — review-trivial emits SHA-bound,
		// merge-consumed verdicts, so its omission was a live fail-OPEN §CP-bypass this fix closes.
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/release/SKILL.md")).toBe(true);
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/review-trivial/SKILL.md")).toBe(
			true,
		);
		// a `.sh` helper in a NON-gate skill's SUBDIR (#2950) — the escape set the any-depth
		// `([^/]+/)*[^/]+\.sh$` clause closes. `report/footer.sh` emits the filing-provenance
		// marker triage keys ADR-0159 auto-close eligibility on, so it feeds a gate decision yet
		// escaped §CP under the old top-level-only `[^/]+\.sh$` anchoring — could auto-merge.
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/report/footer.sh")).toBe(true);
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/doctor/doctor.sh")).toBe(true);
		// depth is irrelevant — a hypothetical helper two levels deep is §CP too (no new anchoring accident).
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/report/lib/helper.sh")).toBe(true);
	});

	it("classifies gate-shared text under skills/shared/ as control-plane (#4396)", () => {
		// Text a gate is instructed to FOLLOW is gate-critical wherever it is hosted, so extracting it
		// out of a consumer's SKILL.md to cut per-run load cost must not buy that saving by dropping it
		// out of §CP. The whole-tree skills clause (#4446) already covers it; this pins that, so a
		// future re-narrowing of the clause reds here instead of silently un-gating the shared text.
		expect(
			isControlPlane("claude-plugins/kampus-pipeline/skills/shared/specialist-fan-out.md"),
		).toBe(true);
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/shared/anything-else.md")).toBe(
			true,
		);
	});

	it("classifies the lint/GritQL governance config as control-plane (ADR 0193)", () => {
		// An ungated path to weaken a lint rule is a guard-relaxing vector — same class as ADR 0187's
		// enforcement-surface test. The root biome config and every GritQL plugin rule are §CP.
		expect(isControlPlane("biome.jsonc")).toBe(true);
		expect(isControlPlane("biome-plugins/no-raw-try-catch.grit")).toBe(true);
		expect(isControlPlane("biome-plugins/no-type-assertions.grit")).toBe(true);
	});

	it("classifies the local hook-wiring config as control-plane (founder ruling on #3402)", () => {
		// `lefthook.yml` wires the ref-guard (#2143) and the #2778 primary-index guards, which have
		// no CI backstop — an edit that unwires them must not auto-ship. The clause is a SHAPE, so
		// every filename lefthook discovers is covered without enumerating any of them (#2393).
		expect(isControlPlane("lefthook.yml")).toBe(true);
		expect(isControlPlane(".lefthookrc")).toBe(true);
		for (const ext of ["yml", "yaml", "toml", "json"]) {
			expect(isControlPlane(`lefthook.${ext}`)).toBe(true);
			expect(isControlPlane(`lefthook-local.${ext}`)).toBe(true);
			expect(isControlPlane(`.lefthook.${ext}`)).toBe(true);
		}
		// depth-agnostic, like the skill-`.sh` clause: a nested package's own config is §CP too.
		expect(isControlPlane("apps/web/lefthook.yml")).toBe(true);
		expect(isControlPlane("packages/pipeline-cli/nested/lefthook.yml")).toBe(true);
	});

	it("does NOT over-widen: the lefthook clause matches lefthook-named LEAVES only", () => {
		// The negative half of the #3402 clause — a clause that matched everything would pass a
		// positive-only test. The stem anchors the leaf, so neither a sibling root config nor an
		// ordinary file that merely MENTIONS lefthook is swept in.
		expect(isControlPlane("package.json")).toBe(false);
		expect(isControlPlane(".decisions/0068-adopt-lefthook-at-second-git-hook.md")).toBe(false);
		expect(isControlPlane("apps/web/src/hooks/use-lefthook.ts")).toBe(false);
		// the stem must START the leaf — a name that merely CONTAINS it stays out
		expect(isControlPlane("docs/my-lefthook-notes.md")).toBe(false);
		// `[^/]+` demands a leaf after the stem, so a bare `lefthook` DIRECTORY prefix is not §CP
		expect(isControlPlane("lefthook/README.md")).toBe(false);
	});

	it("classifies the root marketplace manifest as control-plane (ADR 0212, #3933)", () => {
		// The file declaring what the `kampus` marketplace serves — including kampus-pipeline's
		// `source` tree, which validate-gate-path-drift.sh resolves .claude/skills against. It gets
		// its own branch because `^(\.claude|\.github)/` demands a literal `/` after `.claude` and
		// the character here is a hyphen.
		expect(isControlPlane(".claude-plugin/marketplace.json")).toBe(true);
	});

	it("does NOT over-widen: the marketplace branch is ROOT-anchored (ADR 0212)", () => {
		// A NESTED plugin manifest stays out — an un-anchored form would sweep in every sibling
		// plugin's own plugin.json, which a live founder ruling keeps out of §CP (#3765).
		expect(isControlPlane("claude-plugins/fabrika/.claude-plugin/plugin.json")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/.claude-plugin/plugin.json")).toBe(false);
		// and a look-alike sibling of the root dir is not swallowed either
		expect(isControlPlane(".claude-plugins/marketplace.json")).toBe(false);
	});

	it("does NOT classify known non-§CP paths", () => {
		expect(isControlPlane("apps/web/src/main.tsx")).toBe(false);
		expect(isControlPlane("packages/some-other-pkg/src/index.ts")).toBe(false);
		// A sibling package that is not gate machinery is NOT §CP (#3147, reverse of #3072): only
		// the surfaces that perform/enforce merges & reviews stay §CP.
		expect(isControlPlane("packages/fabrika-cli/src/index.ts")).toBe(false);
		expect(isControlPlane("packages/fabrika-cli/package.json")).toBe(false);
		// biome-governance §CP (ADR 0193) is tightly anchored: some OTHER root config/file stays
		// non-§CP (a NEGATIVE), and `biome\.jsonc$` end-anchors so a look-alike suffix is not §CP.
		expect(isControlPlane("turbo.json")).toBe(false);
		expect(isControlPlane("pnpm-workspace.yaml")).toBe(false);
		expect(isControlPlane("biome.jsonc.bak")).toBe(false);
		// §CP by PATH is a separate axis from §CP by CONTENT: a `.decisions/**` ADR is §CP only
		// when the guard-content probe (ADR 0164) matches its prose, never by path. These stay
		// non-§CP by path — asserted so a boundary widening can't silently capture them.
		expect(isControlPlane(".decisions/0193-lint-governance-config-is-control-plane.md")).toBe(
			false,
		);
		expect(isControlPlane(".patterns/index.md")).toBe(false);
		expect(isControlPlane(".glossary/LANGUAGE.md")).toBe(false);
		expect(isControlPlane("ROADMAP.md")).toBe(false);
	});

	it("still classifies every PRE-EXISTING §CP path (no branch dropped)", () => {
		for (const path of [
			".claude/settings.json",
			".github/workflows/ci.yml",
			"claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md",
			"claude-plugins/kampus-pipeline/skills/triage/SKILL.md",
			"claude-plugins/kampus-pipeline/agents/shipper.md",
			"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
			"claude-plugins/kampus-pipeline/hooks/install.sh",
			"claude-plugins/kampus-pipeline/hooks.json",
			"packages/ci-required/src/bin.ts",
			"packages/pipeline-cli/src/registry.ts",
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});
});

// The whole `kampus-pipeline` skills tree is §CP — founder ruling on #4446, built by #4458.
// The DIRECTORY is the unit of coverage, not the file type. Every case in the first two tests
// below classified NOT-control-plane before the widening (`cp-classify` exit 3 = proven-ordinary,
// which under a CODEOWNERS with no `*` catch-all and a ruleset at
// `required_approving_review_count: 0` means a ZERO-approval merge) — they are the regression
// suite, not decoration, and they go red on any future narrowing of the branch.
describe("CONTROL_PLANE_RE covers the kampus-pipeline skills tree whole (#4458)", () => {
	const skills = "claude-plugins/kampus-pipeline/skills";

	it("classifies a NON-`.sh` file beside a gated script — the proven zero-approval hole", () => {
		for (const path of [
			`${skills}/shared/notes.env`, // exit 3 before
			`${skills}/shared/scripts/helper`, // extensionless — exit 3 before
			`${skills}/shared/scripts/README.md`, // exit 3 before
			`${skills}/shared/specialist-fan-out.md`, // the #4440 relocation destination
			`${skills}/shared/scripts/cp-read.sh`, // the `.sh` case that was already covered
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});

	it("classifies the four skill dirs ADR 0174 deliberately excluded — the accepted approval cost", () => {
		// Superseded by the founder ruling: operational skills gate nothing, but the directory —
		// not gate-criticality, and not the extension — is now what decides §CP membership. The
		// non-`.sh` half of each of these classified not-control-plane before the widening.
		for (const skill of ["heal-ci", "what-shipped", "doctor", "wayfinder"]) {
			expect(isControlPlane(`${skills}/${skill}/SKILL.md`)).toBe(true);
		}
		expect(isControlPlane(`${skills}/heal-ci/helper.md`)).toBe(true);
		expect(isControlPlane(`${skills}/doctor/notes.txt`)).toBe(true);
		expect(isControlPlane(`${skills}/doctor/doctor.shell`)).toBe(true);
		// a future skill dir nobody has enumerated anywhere is covered by construction
		expect(isControlPlane(`${skills}/some-skill-added-tomorrow/SKILL.md`)).toBe(true);
		expect(isControlPlane(`${skills}/some-skill/deeply/nested/fixture.json`)).toBe(true);
	});

	it("does NOT over-widen: the branch is anchored to that ONE directory", () => {
		// A directory-scoped row is broad by design, so the boundary of the breadth is the
		// assertion that matters. The trailing `/` is load-bearing — a sibling whose name merely
		// STARTS with `skills` is not swept in.
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills-notes/draft.md")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/README.md")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/.claude-plugin/plugin.json")).toBe(false);
		// and it stays scoped to kampus-pipeline: a sibling plugin's corpus is OUT of §CP on a live
		// founder ruling re-affirmed 2026-07-24 (#3765), which this widening does not touch.
		expect(isControlPlane("claude-plugins/fabrika/agents/some-agent.md")).toBe(false);
		expect(isControlPlane("claude-plugins/fabrika/skills/some-skill/SKILL.md")).toBe(false);
		expect(isControlPlane("claude-plugins/fabrika/skills/lib/helper.sh")).toBe(false);
	});
});

// #4484 moved the shared shell library out of the skills tree. Outside `skills/**` a path is
// proven-ordinary (`cp-classify` exit 3 — ZERO required approvals under the live ruleset), so the
// move only stays safe while this branch exists. These cases go red the moment it is narrowed.
describe("CONTROL_PLANE_RE covers the relocated shared shell lib (#4484)", () => {
	const lib = "claude-plugins/kampus-pipeline/lib";

	it("classifies the plugin lib/ whole — every file, any depth, any extension", () => {
		for (const path of [
			`${lib}/common.sh`, // the library every extracted per-skill script sources
			`${lib}/common-test.sh`, // its executable pin
			`${lib}/README.md`, // non-`.sh`: the zero-approval hole the DIRECTORY unit closes
			`${lib}/common.env`,
			`${lib}/extensionless-helper`,
			`${lib}/nested/deeply/fixture.json`,
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});

	it("does NOT over-widen: a path just outside the branch stays proven-ordinary", () => {
		// The negative half is the assertion that matters — a branch broad enough to be safe is
		// only honest if its edge is pinned. The trailing `/` is load-bearing, and a same-named
		// dir under a different plugin or a different parent is NOT swept in.
		expect(isControlPlane("claude-plugins/kampus-pipeline/lib-notes/draft.md")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/libs/common.sh")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/scripts/common.sh")).toBe(false);
		expect(isControlPlane("claude-plugins/fabrika/lib/common.sh")).toBe(false);
		expect(isControlPlane("lib/common.sh")).toBe(false);
	});
});

// ADR 0218 — the pipeline-cli boundary is an enforcement CORE, not the whole package. Both
// directions are asserted: every one of these cases flips under the pre-0218 blanket
// `^packages/pipeline-cli/` branch, which classified all of them control-plane.
describe("CONTROL_PLANE_RE narrows packages/pipeline-cli to its enforcement core (ADR 0218)", () => {
	it("keeps the src/ ROOT — every shared-dispatch + plumbing module, not just the four listed", () => {
		for (const path of [
			"packages/pipeline-cli/src/registry.ts",
			"packages/pipeline-cli/src/router.ts",
			"packages/pipeline-cli/src/bin.ts",
			"packages/pipeline-cli/src/gate-fail.ts",
			// the modules a hand-maintained four-file list would have missed — the rot the
			// non-recursive `src/[^/]+$` pattern closes by construction
			"packages/pipeline-cli/src/read-stdin.ts",
			"packages/pipeline-cli/src/read-stdin-core.ts",
			"packages/pipeline-cli/src/tool-registration.ts",
			"packages/pipeline-cli/src/run.ts",
			"packages/pipeline-cli/src/module-load-guard.ts",
			"packages/pipeline-cli/src/annotate.ts",
			"packages/pipeline-cli/src/find-root-dir.ts",
			"packages/pipeline-cli/src/version.ts",
			"packages/pipeline-cli/src/some-module-added-tomorrow.ts",
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});

	it("keeps all EIGHT enforcement-core tools, including the three the 9-path list omitted", () => {
		for (const path of [
			"packages/pipeline-cli/src/tools/ci-required/bin.ts",
			"packages/pipeline-cli/src/tools/verdict/verdict-match.ts",
			"packages/pipeline-cli/src/tools/cp-cardinality/command.ts",
			"packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts",
			"packages/pipeline-cli/src/tools/codeowners-cp/gate.ts",
			// the three retained by the founder ruling on top of the issue's original nine
			"packages/pipeline-cli/src/tools/cp-classify/cp-classify.ts",
			"packages/pipeline-cli/src/tools/trivial-diff/route.ts",
			"packages/pipeline-cli/src/tools/review-head/resolve-head.ts",
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});

	it("keeps tracker/gh-io.ts — the ADR-0055 write+ ACL `verdict` resolves authority against", () => {
		// One FILE inside an otherwise non-core directory: `authorizedAuthors` feeds
		// `resolveVerdict`, so an unreviewed widening would let a forged verdict count as a PASS.
		expect(isControlPlane("packages/pipeline-cli/src/tools/tracker/gh-io.ts")).toBe(true);
		// …and the anchor really is file-level — its siblings and the directory stay out.
		for (const path of [
			"packages/pipeline-cli/src/tools/tracker/command.ts",
			"packages/pipeline-cli/src/tools/tracker/claim.ts",
			"packages/pipeline-cli/src/tools/tracker/gh-io.unit.test.ts",
			"packages/pipeline-cli/src/tools/tracker/nested/gh-io.ts",
		]) {
			expect(isControlPlane(path)).toBe(false);
		}
	});

	it("releases the non-gating tools — coordination + read tooling, and the Tier-3 guards", () => {
		for (const path of [
			"packages/pipeline-cli/src/tools/checks/command.ts",
			"packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts",
			"packages/pipeline-cli/src/tools/spawn-guard/command.ts",
			"packages/pipeline-cli/src/tools/worktree-guard/command.ts",
			"packages/pipeline-cli/src/tools/structured-output-guard/command.ts",
			"packages/pipeline-cli/src/tools/guard-content-probe/command.ts",
			"packages/pipeline-cli/src/tools/merge-intent/command.ts",
			"packages/pipeline-cli/src/tools/roadmap/command.ts",
		]) {
			expect(isControlPlane(path)).toBe(false);
		}
	});

	it("releases the package-root non-src surfaces (package.json, build + test config)", () => {
		for (const path of [
			"packages/pipeline-cli/package.json",
			"packages/pipeline-cli/tsconfig.json",
			"packages/pipeline-cli/vitest.config.ts",
			"packages/pipeline-cli/TOOLS.md",
			"packages/pipeline-cli/README.md",
		]) {
			expect(isControlPlane(path)).toBe(false);
		}
	});

	it("leaves the independent ^packages/ci-required/ branch byte-unchanged in effect", () => {
		expect(isControlPlane("packages/ci-required/src/bin.ts")).toBe(true);
		expect(CONTROL_PLANE_RE).toContain("^packages/ci-required/");
	});
});

// Drift guard: the const IS the single source, and the un-importable formats-doc copy the live
// gates read from origin/main (#981) must stay byte-equal to it. This is the cheap in-test twin
// of the codeowners-cp + validate-gate-path-drift.sh guards that run unconditionally in CI (#2761).
describe("the §CP const stays in lockstep with the formats-doc CONTROL_PLANE_RE line", () => {
	const FORMATS_PATH = fileURLToPath(
		new URL(
			"../../../../../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
			import.meta.url,
		),
	);

	it("equals the CONTROL_PLANE_RE= line extracted from the formats doc on disk", () => {
		const formats = extractControlPlaneRe(readFileSync(FORMATS_PATH, "utf8"));
		expect(formats).not.toBeNull();
		expect(CONTROL_PLANE_RE).toBe(formats);
	});
});
