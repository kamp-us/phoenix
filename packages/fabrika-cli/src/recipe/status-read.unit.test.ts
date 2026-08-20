import {describe, expect, it} from "vitest";
import {clearProof, issueOf, leafOf} from "./status-read.ts";

const status = (stateValue: unknown): string => JSON.stringify({stateValue, status: "active"});

describe("leafOf", () => {
	it("reads the only task of a single-task active phase with no --task", () => {
		const read = leafOf(status({pipeline: {issue: "human:cp-approval"}}), null);

		expect(read).toEqual({_tag: "Leaf", task: "issue", leaf: "human:cp-approval", cause: null});
	});

	it("reads the named task past the future phases the fold marks waiting", () => {
		const read = leafOf(
			status({phase1: {issue_1: "blocked", issue_2: "build"}, phase2: "waiting"}),
			"issue_2",
		);

		expect(read).toEqual({_tag: "Leaf", task: "issue_2", leaf: "build", cause: null});
	});

	it("reads the park cause the fold hung on the task's context", () => {
		const read = leafOf(
			JSON.stringify({
				stateValue: {pipeline: {issue: "blocked"}},
				status: "active",
				context: {issue: {retries: 0, cause: "worktree-holds-branch"}},
			}),
			null,
		);

		expect(read).toMatchObject({leaf: "blocked", cause: "worktree-holds-branch"});
	});

	it("is causeless on a context with no cause, a cause that is not a string, or no context", () => {
		const at = (context: unknown) =>
			leafOf(JSON.stringify({stateValue: {pipeline: {issue: "blocked"}}, context}), null);

		expect(at({issue: {retries: 0}})).toMatchObject({cause: null});
		expect(at({issue: {cause: 7}})).toMatchObject({cause: null});
		expect(at(undefined)).toMatchObject({cause: null});
	});

	it("refuses to guess on a multi-task phase with no --task", () => {
		const read = leafOf(status({phase1: {issue_1: "blocked", issue_2: "build"}}), null);

		expect(read._tag).toBe("Unreadable");
		expect(read._tag === "Unreadable" && read.reason).toMatch(/--task is required/);
	});

	it("refuses a task outside the active phase rather than inventing a leaf", () => {
		const read = leafOf(status({phase1: {issue_1: "blocked"}, phase2: "waiting"}), "issue_9");

		expect(read._tag).toBe("Unreadable");
		expect(read._tag === "Unreadable" && read.reason).toMatch(/not in the active phase/);
	});

	it("answers Finished on a terminal, never a leaf a park could be read from", () => {
		expect(leafOf(status("complete"), null)).toEqual({_tag: "Finished", terminal: "complete"});
	});

	it("is Unreadable on bytes that carry no stateValue", () => {
		expect(leafOf("not json", null)._tag).toBe("Unreadable");
		expect(leafOf(JSON.stringify({status: "active"}), null)._tag).toBe("Unreadable");
	});
});

describe("clearProof", () => {
	it("is Cleared when the re-fold reads the task out of the park", () => {
		const proof = clearProof(0, status({pipeline: {issue: "ship"}}), "issue");

		expect(proof).toEqual({_tag: "Cleared", leaf: "ship"});
	});

	it("is Unproven when the re-fold refused — never read as a clear", () => {
		const proof = clearProof(11, "", "issue");

		expect(proof._tag).toBe("Unproven");
		expect(proof._tag === "Unproven" && proof.reason).toMatch(/refused at exit 11/);
	});

	it("is Unproven when the re-fold's bytes name no leaf", () => {
		expect(clearProof(0, "not json", "issue")._tag).toBe("Unproven");
	});

	it("is Unproven when the task is still in a park", () => {
		const proof = clearProof(0, status({pipeline: {issue: "human:cp-approval"}}), "issue");

		expect(proof._tag).toBe("Unproven");
		expect(proof._tag === "Unproven" && proof.reason).toMatch(/still reads the park/);
	});
});

describe("issueOf", () => {
	it("takes the number out of an emitted epic lane's task name", () => {
		expect(issueOf("5840", "issue_5847")).toBe(5847);
	});

	it("falls back to the lane id on a single-issue lane", () => {
		expect(issueOf("5847", "issue")).toBe(5847);
	});

	it("is null when neither names a number", () => {
		expect(issueOf("nightly-sweep", "issue")).toBeNull();
	});
});
