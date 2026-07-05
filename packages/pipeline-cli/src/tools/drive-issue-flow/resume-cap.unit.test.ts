import {describe, expect, it} from "vitest";
import {HEALTHY_RESUME_CAP, type HealthyResumeLedger, resumeCapDecision} from "./resume-cap.ts";

const ledger = (over: Partial<HealthyResumeLedger> = {}): HealthyResumeLedger => ({
	subagentId: "sub_healthy",
	cycles: 0,
	...over,
});

describe("resumeCapDecision — single healthy-subagent resume cap (ADR 0152 (b) / #2053)", () => {
	it("resumes a fresh (never-resumed) healthy subagent at cycle 1", () => {
		const d = resumeCapDecision(ledger({cycles: 0}));
		expect(d.action).toBe("resume");
		if (d.action === "resume") {
			expect(d.cycle).toBe(1);
			expect(d.subagentId).toBe("sub_healthy");
		}
	});

	it("resumes while strictly under the cap, at cycle = cycles + 1", () => {
		for (let c = 0; c < HEALTHY_RESUME_CAP; c++) {
			const d = resumeCapDecision(ledger({cycles: c}));
			expect(d.action).toBe("resume");
			if (d.action === "resume") {
				expect(d.cycle).toBe(c + 1);
			}
		}
	});

	it("respawns (does NOT resume) once the healthy subagent has hit the cap", () => {
		const d = resumeCapDecision(ledger({cycles: HEALTHY_RESUME_CAP}));
		expect(d.action).toBe("respawn");
		if (d.action === "respawn") {
			expect(d.reason).toBe("cap-reached");
		}
	});

	it("respawns for any cycle count at or beyond the cap (never over-resumes)", () => {
		for (const c of [HEALTHY_RESUME_CAP, HEALTHY_RESUME_CAP + 1, HEALTHY_RESUME_CAP + 10]) {
			expect(resumeCapDecision(ledger({cycles: c})).action).toBe("respawn");
		}
	});

	it("caps the resume of the SAME subagent at exactly K healthy cycles, then respawns", () => {
		// Walk one subagent's healthy resume chain: cycle count starts at 0 and the caller
		// persists the returned `cycle` as the new `cycles`. Exactly K resumes, then a respawn.
		let cycles = 0;
		const resumes: number[] = [];
		for (let step = 0; step < HEALTHY_RESUME_CAP + 3; step++) {
			const d = resumeCapDecision(ledger({subagentId: "sub_chain", cycles}));
			if (d.action === "resume") {
				resumes.push(d.cycle);
				cycles = d.cycle;
			} else {
				break;
			}
		}
		// exactly K resumes (1..K), then the loop broke on the respawn
		expect(resumes).toEqual(Array.from({length: HEALTHY_RESUME_CAP}, (_, i) => i + 1));
		expect(resumeCapDecision(ledger({subagentId: "sub_chain", cycles})).action).toBe("respawn");
	});

	it("a fresh spawn zeroes the budget — the successor gets a full K again (per-instance ledger)", () => {
		// The original hit the cap → respawn. A fresh instance carries cycles=0, so it is resumed.
		expect(
			resumeCapDecision(ledger({subagentId: "sub_old", cycles: HEALTHY_RESUME_CAP})).action,
		).toBe("respawn");
		const successor = resumeCapDecision(ledger({subagentId: "sub_fresh", cycles: 0}));
		expect(successor.action).toBe("resume");
		if (successor.action === "resume") {
			expect(successor.cycle).toBe(1);
		}
	});

	it("treats a corrupt (negative / non-integer) cycle count as a fresh instance (fail-safe)", () => {
		for (const bad of [-1, Number.NaN, 2.5]) {
			const d = resumeCapDecision(ledger({cycles: bad}));
			expect(d.action).toBe("resume");
			if (d.action === "resume") {
				expect(d.cycle).toBe(1);
			}
		}
	});

	it("honors an explicit small cap for testability (production uses the recorded default)", () => {
		expect(resumeCapDecision(ledger({cycles: 0}), 1).action).toBe("resume");
		expect(resumeCapDecision(ledger({cycles: 1}), 1).action).toBe("respawn");
	});

	it("records the cap value and its rationale (ADR 0152 AC: K and its rationale recorded)", () => {
		expect(HEALTHY_RESUME_CAP).toBe(5);
		const capped = resumeCapDecision(ledger({cycles: HEALTHY_RESUME_CAP}));
		// the respawn rationale names the lifetime axis and cross-references #1751 + ADR 0152
		expect(capped.rationale).toMatch(/lifetime cap K=5/);
		expect(capped.rationale).toMatch(/ADR 0152/);
		expect(capped.rationale).toMatch(/#1751/);
		expect(capped.rationale).toMatch(/HEALTHY/i);
	});
});

// The load-bearing separation property: this decision is driven ONLY by the healthy-resume
// cycle count and NEVER by a crash count — so it can neither be triggered by nor perturb
// #1751's crash budget (ADR 0152: the two axes stay distinct, a resume never double-counts).
describe("resume-cap is distinct from #1751's crash budget (ADR 0152 — no double-count)", () => {
	it("decides purely on the healthy `cycles` ledger field — a crash count is not an input", () => {
		// The ledger shape carries ONLY `subagentId` + `cycles`; there is no crash-count field to
		// conflate. Same `cycles` ⇒ same decision regardless of any (absent) crash history.
		const a = resumeCapDecision(ledger({subagentId: "x", cycles: 2}));
		const b = resumeCapDecision(ledger({subagentId: "x", cycles: 2}));
		expect(a).toEqual(b);
	});

	it("a healthy chain under the crash cap (K=2) still resumes — the two caps do not sum", () => {
		// #1751's crash cap is K=2. A healthy subagent resumed 3 times (past the crash K, under the
		// healthy K=5) must STILL resume here — proving the healthy cap is not the crash cap and the
		// budgets are not summed into a premature respawn.
		const d = resumeCapDecision(ledger({cycles: 3}));
		expect(d.action).toBe("resume");
		if (d.action === "resume") {
			expect(d.cycle).toBe(4);
		}
	});
});
