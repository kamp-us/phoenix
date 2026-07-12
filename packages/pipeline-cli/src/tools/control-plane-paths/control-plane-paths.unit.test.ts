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
	});

	it("does NOT classify the four deliberately-OUT skill dirs (operational, not gate-critical)", () => {
		for (const skill of ["heal-ci", "what-shipped", "doctor", "wayfinder"]) {
			expect(isControlPlane(`claude-plugins/kampus-pipeline/skills/${skill}/SKILL.md`)).toBe(false);
		}
	});

	it("does NOT classify known non-§CP paths", () => {
		expect(isControlPlane("apps/web/src/main.tsx")).toBe(false);
		expect(isControlPlane("packages/some-other-pkg/src/index.ts")).toBe(false);
		// a nested `.sh` UNDER a non-§CP skill dir is not the bare-guard branch (that requires the
		// script sit directly under skills/, matched by `[^/]+\.sh$`).
		expect(isControlPlane("claude-plugins/kampus-pipeline/skills/heal-ci/helper.sh")).toBe(false);
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
