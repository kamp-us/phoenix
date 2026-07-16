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

	it("does NOT classify the four deliberately-OUT skill dirs (operational, not gate-critical)", () => {
		for (const skill of ["heal-ci", "what-shipped", "doctor", "wayfinder"]) {
			expect(isControlPlane(`claude-plugins/kampus-pipeline/skills/${skill}/SKILL.md`)).toBe(false);
		}
	});

	it("does NOT classify known non-§CP paths", () => {
		expect(isControlPlane("apps/web/src/main.tsx")).toBe(false);
		expect(isControlPlane("packages/some-other-pkg/src/index.ts")).toBe(false);
		// pipeline-crew-mcp is crew-coordination tooling, NOT gate machinery — declassified from §CP
		// (#3147, reverse of #3072). Its child PRs auto-merge on the normal review gates; only the
		// surfaces that perform/enforce merges & reviews stay §CP.
		expect(isControlPlane("packages/pipeline-crew-mcp/src/index.ts")).toBe(false);
		expect(isControlPlane("packages/pipeline-crew-mcp/package.json")).toBe(false);
		// Over-broadening guard (#2950): the any-depth clause matches `.sh` LEAVES only — a
		// NON-`.sh` file in a non-gate skill's subdir stays non-§CP, so the broadening didn't
		// silently swallow whole non-gate skill dirs (only their shell helpers).
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/heal-ci/helper.md")).toBe(false);
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/doctor/notes.txt")).toBe(false);
		// a `.sh`-suffixed name that is NOT a `.sh` file (no such extension boundary) also stays out
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/doctor/doctor.shell")).toBe(false);
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
