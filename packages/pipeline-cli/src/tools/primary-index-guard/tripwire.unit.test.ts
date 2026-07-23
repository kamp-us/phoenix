import {describe, expect, it} from "@effect/vitest";
import {
	CONTROL_PLANE_DELETION_PREFIXES,
	decideTripwire,
	isControlPlaneDeletion,
	parseNameStatus,
	type StagedEntry,
	type TripwireInput,
} from "./tripwire.ts";

const del = (path: string): StagedEntry => ({status: "D", path});

const base: Omit<TripwireInput, "staged"> = {
	onPrimaryCheckout: true,
	cwd: "/repo",
	agentType: "coder",
	sessionId: "sess-1",
	worktreeRoot: "",
	threshold: 10,
	at: "2026-07-12T00:00:00Z",
};

describe("isControlPlaneDeletion", () => {
	it("matches every instruction-trust prefix", () => {
		for (const prefix of CONTROL_PLANE_DELETION_PREFIXES) {
			expect(isControlPlaneDeletion(`${prefix}some/file.md`)).toBe(true);
		}
	});

	it("does not match ordinary source paths", () => {
		expect(isControlPlaneDeletion("apps/web/src/App.tsx")).toBe(false);
		expect(isControlPlaneDeletion("packages/authz/src/index.ts")).toBe(false);
		// a substring that is not a leading prefix must not match
		expect(isControlPlaneDeletion("docs/.claude/x")).toBe(false);
	});
});

describe("decideTripwire", () => {
	it("trips on a mass control-plane staged deletion (the #2778 signature)", () => {
		const staged = Array.from({length: 30}, (_, i) => del(`.claude/skills/x${i}.md`));
		const decision = decideTripwire({...base, staged});
		expect(decision.kind).toBe("trip");
		if (decision.kind !== "trip") return;
		expect(decision.record.controlPlaneDeletionCount).toBe(30);
		expect(decision.record.stagedDeletionCount).toBe(30);
		expect(decision.record.onPrimaryCheckout).toBe(true);
		expect(decision.record.sampleControlPlaneDeletions.length).toBe(8); // bounded sample
		expect(decision.record.agentType).toBe("coder");
	});

	it("stays quiet below the threshold", () => {
		const staged = [del(".claude/a.md"), del(".decisions/b.md")];
		const decision = decideTripwire({...base, staged, threshold: 10});
		expect(decision.kind).toBe("quiet");
		if (decision.kind !== "quiet") return;
		expect(decision.reason).toContain("< threshold 10");
	});

	it("counts only control-plane paths toward the threshold, but reports total deletions", () => {
		const staged = [
			...Array.from({length: 12}, (_, i) => del(`.decisions/${i}.md`)),
			...Array.from({length: 40}, (_, i) => del(`apps/web/src/${i}.ts`)),
		];
		const decision = decideTripwire({...base, staged, threshold: 10});
		expect(decision.kind).toBe("trip");
		if (decision.kind !== "trip") return;
		expect(decision.record.controlPlaneDeletionCount).toBe(12);
		expect(decision.record.stagedDeletionCount).toBe(52);
	});

	it("ignores non-deletion staged entries (only D-status counts)", () => {
		const staged: StagedEntry[] = [
			...Array.from({length: 20}, (_, i) => ({status: "M", path: `.claude/${i}.md`})),
			del(".claude/one.md"),
		];
		const decision = decideTripwire({...base, staged, threshold: 10});
		expect(decision.kind).toBe("quiet"); // 1 deletion < 10, the 20 modifications don't count
	});

	it("still trips on a linked worktree but records the lower severity", () => {
		const staged = Array.from({length: 15}, (_, i) => del(`.patterns/${i}.md`));
		const decision = decideTripwire({
			...base,
			staged,
			onPrimaryCheckout: false,
			worktreeRoot: "/wt",
		});
		expect(decision.kind).toBe("trip");
		if (decision.kind !== "trip") return;
		expect(decision.record.onPrimaryCheckout).toBe(false);
		expect(decision.record.worktreeRoot).toBe("/wt");
	});
});

describe("parseNameStatus", () => {
	it("parses tab-separated git name-status rows", () => {
		const raw = "D\t.claude/a.md\nD\t.decisions/0001-x.md\n\nD\t.github/workflows/ci.yml\n";
		expect(parseNameStatus(raw)).toEqual([
			{status: "D", path: ".claude/a.md"},
			{status: "D", path: ".decisions/0001-x.md"},
			{status: "D", path: ".github/workflows/ci.yml"},
		]);
	});

	it("returns empty for empty input", () => {
		expect(parseNameStatus("")).toEqual([]);
		expect(parseNameStatus("\n\n")).toEqual([]);
	});
});
