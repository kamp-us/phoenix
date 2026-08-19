import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {extractControlPlaneRe} from "../codeowners-cp/codeowners-cp.ts";
import {CONTROL_PLANE_RE} from "./control-plane-re.ts";

// The boundary as the live gates apply it: a POSIX-ERE `grep -Eq`, here a RegExp over the
// same const string (every branch is `^`-anchored, so `.test` is prefix-anchored per branch).
const isControlPlane = (path: string): boolean => new RegExp(CONTROL_PLANE_RE).test(path);

describe("CONTROL_PLANE_RE classifies the ADR-0174 boundary broadenings (#2761)", () => {
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
		// depth-agnostic, like the retired skill-`.sh` clause: a nested package's own config is §CP too.
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
		// The file declaring what the `kampus` marketplace serves and each plugin's `source`
		// tree. It gets its own branch because `^(\.claude|\.github)/` demands a literal `/`
		// after `.claude` and the character here is a hyphen.
		expect(isControlPlane(".claude-plugin/marketplace.json")).toBe(true);
	});

	it("does NOT over-widen: the marketplace branch is ROOT-anchored (ADR 0212)", () => {
		// A NESTED plugin manifest stays out — an un-anchored form would sweep in every sibling
		// plugin's own plugin.json, which a live founder ruling keeps out of §CP (#3765).
		expect(isControlPlane("claude-plugins/fabrika/.claude-plugin/plugin.json")).toBe(false);
		// and a look-alike sibling of the root dir is not swallowed either
		expect(isControlPlane(".claude-plugins/marketplace.json")).toBe(false);
	});

	it("does NOT classify known non-§CP paths", () => {
		expect(isControlPlane("apps/web/src/main.tsx")).toBe(false);
		expect(isControlPlane("packages/some-other-pkg/src/index.ts")).toBe(false);
		// A sibling package that is not gate machinery is NOT §CP (#3147, reverse of #3072): only
		// the surfaces that perform/enforce merges & reviews stay §CP. fabrika-cli's `src/ci/` is
		// the one exception, asserted in its own describe below.
		expect(isControlPlane("packages/fabrika-cli/src/index.ts")).toBe(false);
		expect(isControlPlane("packages/fabrika-cli/package.json")).toBe(false);
		// The retired kampus-pipeline clauses (#5937) are gone: the plugin tree — were it ever
		// recreated — would classify ordinary, and the fabrika tree stays out by the standing
		// founder ruling (#3765 / ADR 0274).
		expect(isControlPlane("claude-plugins/fabrika/skills/build/SKILL.md")).toBe(false);
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
			"packages/ci-required/src/bin.ts",
			"packages/pipeline-cli/src/registry.ts",
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
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

// ADR 0299 — the `ci-required` verdict core is MOVING to `packages/fabrika-cli/src/ci/` via open
// child #6099 of epic #5720; on `main` today the dir does not exist and `ci.yml` still runs the
// pipeline-cli bin. The fence lands ahead of the move: every path below classifies
// NOT-control-plane on `main`, so without this branch, the day #6099 lands, a PR touching only the
// new dir would merge on ZERO approvals — no `*` catch-all in CODEOWNERS, and the ruleset pairs
// `required_approving_review_count: 0` with `require_code_owner_review: true`.
describe("CONTROL_PLANE_RE covers fabrika-cli's CI-check core (ADR 0299)", () => {
	const ci = "packages/fabrika-cli/src/ci";

	it("classifies the incoming ci-required verdict core — the whole dir, any depth", () => {
		for (const path of [
			`${ci}/required.ts`, // the pass/fail logic itself
			`${ci}/required-bin.ts`, // what .github/workflows/ci.yml's ci-required job runs
			`${ci}/required.unit.test.ts`, // the pin on that logic — weakening it weakens the gate
			`${ci}/README.md`, // non-`.ts`: the zero-approval hole a DIRECTORY unit closes
			`${ci}/nested/helper.ts`,
		]) {
			expect(isControlPlane(path)).toBe(true);
		}
	});

	it("does NOT over-widen: the rest of fabrika-cli stays ordinary (founder ruling on #6164)", () => {
		// The narrowness IS the ruling — "i'm ok with it as long as it's scoped to the ci checks".
		// The negative half is what keeps the approval load where the founder put it, so it is the
		// assertion that would red on a future quiet widening to the whole package.
		for (const path of [
			"packages/fabrika-cli/src/bin.ts",
			"packages/fabrika-cli/src/registry.ts",
			"packages/fabrika-cli/src/ship/command.ts",
			"packages/fabrika-cli/src/review/verdicts.ts",
			"packages/fabrika-cli/package.json",
			// the trailing `/` is load-bearing — a sibling whose name merely starts with `ci`
			"packages/fabrika-cli/src/ci-notes.md",
			// and it is anchored to fabrika-cli's own src/, not to any `src/ci/` anywhere
			"packages/some-other-pkg/src/ci/required.ts",
		]) {
			expect(isControlPlane(path)).toBe(false);
		}
	});
});

// Drift guard: the const IS the single source, and the un-importable prose copy the shell-side
// callers read from origin/main (#981) must stay byte-equal to it. Since #5937 that copy lives
// in boundaries.md beside the const; this is the cheap in-test twin of the codeowners-cp guard
// that runs unconditionally in CI (#2761).
describe("the §CP const stays in lockstep with the boundaries.md CONTROL_PLANE_RE line", () => {
	const FORMATS_PATH = fileURLToPath(new URL("boundaries.md", import.meta.url));

	it("equals the CONTROL_PLANE_RE= line extracted from boundaries.md on disk", () => {
		const formats = extractControlPlaneRe(readFileSync(FORMATS_PATH, "utf8"));
		expect(formats).not.toBeNull();
		expect(CONTROL_PLANE_RE).toBe(formats);
	});
});
