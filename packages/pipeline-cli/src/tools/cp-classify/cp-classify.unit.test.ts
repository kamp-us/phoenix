import {describe, expect, it} from "vitest";
import {CONTROL_PLANE_RE} from "../control-plane-paths/control-plane-re.ts";
import {
	CP_CONTENT_PREFIX,
	classifyControlPlane,
	isContentClassifiedPath,
	isHold,
} from "./cp-classify.ts";

/**
 * The live boundary as the classifier sees it. These tests pin BEHAVIOUR, not the boundary's
 * contents — the const is imported, never re-copied (#2761).
 */
const RE = CONTROL_PLANE_RE;

describe("classifyControlPlane — the four states", () => {
	it("classifies a path match as control-plane and names the matching path", () => {
		const r = classifyControlPlane(["apps/web/src/x.ts", "packages/pipeline-cli/src/bin.ts"], RE);
		expect(r.state).toBe("control-plane");
		expect(r.reason).toBe("path-match");
		expect(r.matchedPath).toBe("packages/pipeline-cli/src/bin.ts");
	});

	it("classifies an ADR-only set as content-undetermined, NOT as not-control-plane (#4161, PR #4134)", () => {
		// The live regression: both files are `.decisions/**`, zero path matches. A path-only
		// classifier called this ordinary work; §CP-by-content (ADR 0164) was invisible to it.
		const r = classifyControlPlane(
			[".decisions/0115-agent-distinguishable-claim-marker.md", ".decisions/0215-claim.md"],
			RE,
		);
		expect(r.state).toBe("content-undetermined");
		expect(r.reason).toBe("content-source-present");
		expect(r.contentSources).toEqual([
			".decisions/0115-agent-distinguishable-claim-marker.md",
			".decisions/0215-claim.md",
		]);
	});

	it("classifies a mixed ordinary+ADR set as content-undetermined", () => {
		const r = classifyControlPlane(["apps/web/src/x.ts", ".decisions/0164-guard.md"], RE);
		expect(r.state).toBe("content-undetermined");
		expect(r.contentSources).toEqual([".decisions/0164-guard.md"]);
	});

	it("classifies a path-clear set with no content source as not-control-plane — the one proven-ordinary verdict", () => {
		const r = classifyControlPlane(["apps/web/src/x.ts", "README.md"], RE);
		expect(r.state).toBe("not-control-plane");
		expect(r.reason).toBe("path-clear-no-content-source");
		expect(r.contentSources).toEqual([]);
	});

	it("prefers control-plane over content-undetermined when a path matches too", () => {
		const r = classifyControlPlane([".decisions/0164-guard.md", ".github/workflows/ci.yml"], RE);
		expect(r.state).toBe("control-plane");
	});
});

describe("classifyControlPlane — unresolvable inputs are `unknown`, never `not-control-plane`", () => {
	// Read-failed and genuinely-non-§CP are DIFFERENT FACTS; collapsing them is the recurring
	// fail-open defect (#3715, #4108, #4171, #4191).
	it("resolves a null boundary to unknown", () => {
		const r = classifyControlPlane(["apps/web/src/x.ts"], null);
		expect(r.state).toBe("unknown");
		expect(r.reason).toBe("boundary-unresolved");
	});

	it("resolves an undefined boundary to unknown", () => {
		expect(classifyControlPlane(["apps/web/src/x.ts"], undefined).state).toBe("unknown");
	});

	it("resolves a blank boundary to unknown", () => {
		expect(classifyControlPlane(["apps/web/src/x.ts"], "   ").reason).toBe("boundary-unresolved");
	});

	it("resolves an uncompilable boundary to unknown — a broken boundary must never match nothing", () => {
		const r = classifyControlPlane(["apps/web/src/x.ts"], "^(unclosed");
		expect(r.state).toBe("unknown");
		expect(r.reason).toBe("boundary-uncompilable");
	});

	it("resolves an empty file set to unknown — zero scope is not evidence of innocence (ADR 0092)", () => {
		const r = classifyControlPlane([], RE);
		expect(r.state).toBe("unknown");
		expect(r.reason).toBe("empty-file-set");
	});

	it("treats a whitespace-only list (a trailing newline) as an empty set, not as a changed file", () => {
		expect(classifyControlPlane(["", "  ", ""], RE).reason).toBe("empty-file-set");
	});

	it("never returns not-control-plane for any unresolvable input", () => {
		const unresolvable = [
			classifyControlPlane(["apps/web/src/x.ts"], null),
			classifyControlPlane(["apps/web/src/x.ts"], ""),
			classifyControlPlane(["apps/web/src/x.ts"], "^(unclosed"),
			classifyControlPlane([], RE),
		];
		for (const r of unresolvable) expect(r.state).not.toBe("not-control-plane");
	});
});

describe("isHold — the exit-code predicate is fail-closed in both directions", () => {
	it("holds on every state except the proven-ordinary one", () => {
		expect(isHold("control-plane")).toBe(true);
		expect(isHold("content-undetermined")).toBe(true);
		expect(isHold("unknown")).toBe(true);
		expect(isHold("not-control-plane")).toBe(false);
	});
});

describe("the content-clause scope is single-sourced", () => {
	it("scopes §CP-by-content to .decisions/** and nothing else (ADR 0164)", () => {
		expect(CP_CONTENT_PREFIX).toBe(".decisions/");
		expect(isContentClassifiedPath(".decisions/0164-guard.md")).toBe(true);
		expect(isContentClassifiedPath(".patterns/index.md")).toBe(false);
		expect(isContentClassifiedPath("docs/.decisions/x.md")).toBe(false);
	});
});
