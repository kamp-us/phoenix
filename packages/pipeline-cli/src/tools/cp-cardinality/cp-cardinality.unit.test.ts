import {describe, expect, it} from "vitest";
import {type CpCardinalityInput, decideCpCardinality} from "./cp-cardinality.ts";

/** Build an input with fail-closed defaults (no signals present), overriding only what a case exercises. */
const input = (over: Partial<CpCardinalityInput> = {}): CpCardinalityInput => ({
	members: [],
	author: "usirin",
	nonAuthorApprovalAtHead: false,
	selfApprovalAtHead: false,
	...over,
});

describe("decideCpCardinality — ADR 0175 §CP team-cardinality branch (#2541)", () => {
	describe("N == 0 (empty team) — fail closed", () => {
		it("STOPs with no members, regardless of any signal", () => {
			const v = decideCpCardinality(
				input({members: [], nonAuthorApprovalAtHead: true, selfApprovalAtHead: true}),
			);
			expect(v.decision).toBe("stop");
			expect(v.n).toBe(0);
			expect(v.branch).toBe("empty");
		});
	});

	describe("N == 1, sole owner == author (single-owner degenerate case)", () => {
		it("discharges on a current-head self-approval marker", () => {
			const v = decideCpCardinality(
				input({members: ["usirin"], author: "usirin", selfApprovalAtHead: true}),
			);
			expect(v.decision).toBe("discharge");
			expect(v.n).toBe(1);
			expect(v.branch).toBe("single-owner-self");
		});

		it("STOPs with no self-approval marker", () => {
			const v = decideCpCardinality(
				input({members: ["usirin"], author: "usirin", selfApprovalAtHead: false}),
			);
			expect(v.decision).toBe("stop");
			expect(v.branch).toBe("single-owner-self");
		});

		it("does NOT discharge on a non-author approval signal (there is no other member to give it)", () => {
			// The only discharge signal for a sole owner IS the self-approval marker; a stray
			// non-author-approval flag must never substitute for it.
			const v = decideCpCardinality(
				input({
					members: ["usirin"],
					author: "usirin",
					nonAuthorApprovalAtHead: true,
					selfApprovalAtHead: false,
				}),
			);
			expect(v.decision).toBe("stop");
		});
	});

	describe("N == 1, sole member != author", () => {
		it("discharges on the sole member's current-head approval", () => {
			const v = decideCpCardinality(
				input({members: ["cansirin"], author: "usirin", nonAuthorApprovalAtHead: true}),
			);
			expect(v.decision).toBe("discharge");
			expect(v.branch).toBe("single-owner-other");
		});

		it("STOPs without that member's current-head approval", () => {
			const v = decideCpCardinality(
				input({members: ["cansirin"], author: "usirin", nonAuthorApprovalAtHead: false}),
			);
			expect(v.decision).toBe("stop");
			expect(v.branch).toBe("single-owner-other");
		});

		it("a self-approval marker does NOT discharge when the sole member is not the author", () => {
			const v = decideCpCardinality(
				input({members: ["cansirin"], author: "usirin", selfApprovalAtHead: true}),
			);
			expect(v.decision).toBe("stop");
		});
	});

	describe("N == 2 (exactly-N, ADR 0135 two-person control) — unchanged", () => {
		it("discharges on a current-head approval by a DIFFERENT control-plane member", () => {
			const v = decideCpCardinality(
				input({members: ["usirin", "cansirin"], author: "usirin", nonAuthorApprovalAtHead: true}),
			);
			expect(v.decision).toBe("discharge");
			expect(v.n).toBe(2);
			expect(v.branch).toBe("multi-member");
		});

		it("STOPs without a different-member current-head approval", () => {
			const v = decideCpCardinality(
				input({members: ["usirin", "cansirin"], author: "usirin", nonAuthorApprovalAtHead: false}),
			);
			expect(v.decision).toBe("stop");
			expect(v.branch).toBe("multi-member");
		});

		it("self-approval is EXCLUDED — a self-approval marker never discharges when N>=2 (ADR 0175 Banned)", () => {
			const v = decideCpCardinality(
				input({
					members: ["usirin", "cansirin"],
					author: "usirin",
					nonAuthorApprovalAtHead: false,
					selfApprovalAtHead: true,
				}),
			);
			expect(v.decision).toBe("stop");
		});
	});

	describe("N == 3 (N+1 boundary) — same multi-member rule", () => {
		it("discharges on a different-member current-head approval", () => {
			const v = decideCpCardinality(
				input({
					members: ["usirin", "cansirin", "third"],
					author: "usirin",
					nonAuthorApprovalAtHead: true,
				}),
			);
			expect(v.decision).toBe("discharge");
			expect(v.n).toBe(3);
			expect(v.branch).toBe("multi-member");
		});

		it("STOPs without one", () => {
			const v = decideCpCardinality(
				input({members: ["usirin", "cansirin", "third"], author: "usirin"}),
			);
			expect(v.decision).toBe("stop");
		});
	});

	describe("roster hygiene — N is a count of DISTINCT, non-blank logins", () => {
		it("dedupes duplicate logins (a doubled roster line does not inflate N to the multi-member branch)", () => {
			const v = decideCpCardinality(
				input({members: ["usirin", "usirin"], author: "usirin", selfApprovalAtHead: true}),
			);
			expect(v.n).toBe(1);
			expect(v.branch).toBe("single-owner-self");
			expect(v.decision).toBe("discharge");
		});

		it("ignores blank/whitespace roster lines", () => {
			const v = decideCpCardinality(input({members: ["", "  ", "cansirin"], author: "usirin"}));
			expect(v.n).toBe(1);
			expect(v.branch).toBe("single-owner-other");
		});

		it("trims logins before matching the author", () => {
			const v = decideCpCardinality(
				input({members: ["  usirin  "], author: "usirin", selfApprovalAtHead: true}),
			);
			expect(v.branch).toBe("single-owner-self");
			expect(v.decision).toBe("discharge");
		});
	});

	describe("unresolvable author — fail closed", () => {
		it("STOPs when the author is empty even with a single self-owner member", () => {
			const v = decideCpCardinality(
				input({members: ["usirin"], author: "", selfApprovalAtHead: true}),
			);
			expect(v.decision).toBe("stop");
		});
	});
});
