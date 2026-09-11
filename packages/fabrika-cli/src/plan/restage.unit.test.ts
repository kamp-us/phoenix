import {describe, expect, it} from "vitest";
import {emitMachine} from "../lane/emit.ts";
import type {SubIssueLink} from "./github.ts";
import {restageBody} from "./restage.ts";

// `SubIssueLink` rather than `Observed`: these fixtures feed `emitMachine` too, which reads the
// whole link, and `Observed` is the narrowing `restageBody` judges.
const open = (number: number): SubIssueLink => ({
	number,
	state: "open",
	stateReason: null,
	classes: [],
});
const closed = (number: number, stateReason: string | null): SubIssueLink => ({
	number,
	state: "closed",
	stateReason,
	classes: [],
});

const body = (dependencies: string, options: {before?: string; after?: string} = {}): string =>
	[
		options.before ?? "An epic.",
		"",
		"## Dependencies",
		"",
		dependencies,
		...(options.after === undefined ? [] : ["", options.after]),
		"",
	].join("\n");

const PHASES = ["- phase 1: #1", "- phase 2: #2, #3", "- #3 requires: #2"].join("\n");

describe("restageBody", () => {
	it("drops a child closed for any reason other than completed", () => {
		const out = restageBody(body(PHASES), [open(1), closed(2, "duplicate"), open(3)]);
		expect(out).toMatchObject({_tag: "Restaged", dropped: [2], kept: [1, 3]});
		if (out._tag !== "Restaged") return;
		expect(out.body).toContain("- phase 1: #1");
		expect(out.body).toContain("- phase 2: #3");
		expect(out.body).not.toContain("#2");
	});

	it("keeps a completed close, whose region boots landed rather than frozen", () => {
		expect(restageBody(body(PHASES), [closed(1, "completed"), open(2), open(3)])).toEqual({
			_tag: "Unchanged",
			kept: [1, 2, 3],
		});
	});

	it("writes nothing over an already-consistent topology", () => {
		expect(restageBody(body(PHASES), [open(1), open(2), open(3)])).toEqual({
			_tag: "Unchanged",
			kept: [1, 2, 3],
		});
	});

	it("is idempotent: restaging its own output is a no-op", () => {
		const observations = [open(1), closed(2, "not_planned"), open(3)];
		const first = restageBody(body(PHASES), observations);
		if (first._tag !== "Restaged") throw new Error(`expected Restaged, got ${first._tag}`);
		expect(restageBody(first.body, observations)).toEqual({_tag: "Unchanged", kept: [1, 3]});
	});

	it("drops a requires: line whose subject went, and one whose needs all went", () => {
		const out = restageBody(
			body(
				["- phase 1: #1, #2", "- phase 2: #3", "- #3 requires: #1", "- #2 requires: #1"].join("\n"),
			),
			[closed(1, "duplicate"), open(2), open(3)],
		);
		expect(out).toMatchObject({_tag: "Restaged", dropped: [1], kept: [2, 3]});
		if (out._tag !== "Restaged") return;
		expect(out.body).toContain("- phase 1: #2");
		expect(out.body).toContain("- phase 2: #3");
		expect(out.body).not.toContain("requires");
	});

	it("drops a phase line that loses every member", () => {
		const out = restageBody(body("- phase 1: #1\n- phase 2: #2"), [
			closed(1, "duplicate"),
			open(2),
		]);
		expect(out).toMatchObject({_tag: "Restaged", dropped: [1], kept: [2]});
		if (out._tag !== "Restaged") return;
		expect(out.body).not.toContain("phase 1");
		expect(out.body).toContain("- phase 2: #2");
	});

	/**
	 * The observations are the epic's sub-issue links, which is the set `lane emit` checks against.
	 * A ref outside them is unobserved, not abandoned, so a reconcile that dropped it would be
	 * rewriting a plan on no evidence.
	 */
	it("leaves a ref the observations do not name exactly as written", () => {
		const out = restageBody(body("- phase 1: #1, #9\n- phase 2: #2\n- #2 requires: C7"), [
			open(1),
			closed(2, "duplicate"),
		]);
		expect(out).toMatchObject({_tag: "Restaged", dropped: [2]});
		if (out._tag !== "Restaged") return;
		expect(out.body).toContain("- phase 1: #1, #9");
		expect(out.body).not.toContain("C7");
	});

	it("round-trips a ledger-local ref rather than losing it", () => {
		const out = restageBody(body("- phase 1: #1, C2\n- phase 2: #3"), [
			open(1),
			closed(3, "duplicate"),
		]);
		expect(out).toMatchObject({_tag: "Restaged", dropped: [3], kept: [1]});
		if (out._tag !== "Restaged") return;
		expect(out.body).toContain("- phase 1: #1, C2");
	});

	it("preserves every byte outside the region", () => {
		const out = restageBody(
			body("- phase 1: #1\n- phase 2: #2", {before: "The brief.", after: "## Notes\n\nKeep me."}),
			[open(1), closed(2, "duplicate")],
		);
		if (out._tag !== "Restaged") throw new Error(`expected Restaged, got ${out._tag}`);
		expect(out.body.startsWith("The brief.")).toBe(true);
		expect(out.body).toContain("## Notes\n\nKeep me.");
	});

	it("refuses rather than emptying the topology to nothing", () => {
		expect(
			restageBody(body("- phase 1: #1, #2"), [closed(1, "duplicate"), closed(2, null)]),
		).toEqual({_tag: "Emptied", dropped: [1, 2]});
	});

	it("names an absent region, an ambiguous one, and an unparseable line apart", () => {
		expect(restageBody("An epic with no plan.\n", [open(1)])).toEqual({_tag: "Absent"});
		expect(
			restageBody("## Dependencies\n\n- phase 1: #1\n\n## Dependencies\n\n- phase 1: #2\n", [
				closed(1, "duplicate"),
			]),
		).toEqual({_tag: "Ambiguous", count: 2});
		expect(restageBody(body("- phase one: #1"), [closed(1, "duplicate")])).toMatchObject({
			_tag: "Unparseable",
			text: "- phase one: #1",
		});
	});

	/** A heading inside the preserved brief is filed content — cutting there is how a body is destroyed. */
	it("refuses a heading that resolves inside the preserved brief envelope", () => {
		const filed = [
			"An epic.",
			"",
			"<!-- fabrika:enriched issue=4300 mode=rewrite -->",
			"<details>",
			"<summary>Original report (verbatim)</summary>",
			"",
			"## Dependencies",
			"",
			"- phase 1: #1",
			"",
			"</details>",
			"",
		].join("\n");
		expect(restageBody(filed, [closed(1, "duplicate")])).toEqual({_tag: "InPreservedBrief"});
	});
});

/**
 * The reconcile's whole point, asserted where the two modules meet rather than in either alone: what
 * `lane emit` does with the region afterwards. `emitMachine` boots a non-`completed` close in
 * `frozen`, a final carrying a door, so the phase trips at startup — that is the failure a hand edit
 * to the epic body used to be the only cure for.
 */
describe("restageBody feeding lane emit", () => {
	const EPIC = 4300;
	const planned = body("- phase 1: #4301, #4302\n- phase 2: #4303\n- #4303 requires: #4301");
	const observations = [open(4301), closed(4302, "duplicate"), open(4303)];

	const initials = (text: string): Record<string, unknown> => {
		const doc = JSON.parse(text) as {
			machine: {states: Record<string, {states?: Record<string, {initial: string}>}>};
		};
		const out: Record<string, unknown> = {};
		for (const phase of Object.values(doc.machine.states)) {
			for (const [task, node] of Object.entries(phase.states ?? {})) out[task] = node.initial;
		}
		return out;
	};

	it("emits a frozen boot over the un-reconciled body", () => {
		const emitted = emitMachine(EPIC, planned, observations);
		if (emitted._tag !== "Emitted") throw new Error(`expected Emitted, got ${emitted._tag}`);
		expect(initials(emitted.text).issue_4302).toBe("frozen");
	});

	it("emits regions for the live children only once the body is reconciled", () => {
		const restaged = restageBody(planned, observations);
		if (restaged._tag !== "Restaged") throw new Error(`expected Restaged, got ${restaged._tag}`);
		const emitted = emitMachine(EPIC, restaged.body, observations);
		if (emitted._tag !== "Emitted") throw new Error(`expected Emitted, got ${emitted._tag}`);
		const booted = initials(emitted.text);
		expect(booted).not.toHaveProperty("issue_4302");
		expect(booted).toMatchObject({issue_4301: "queued", issue_4303: "queued"});
		expect(Object.values(booted)).not.toContain("frozen");
	});
});
