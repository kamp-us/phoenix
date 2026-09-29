import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {admitHandCheck, handCheckCommentId} from "./hand-check.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OWNERS = new Set(["owner"]);
const SHOT = "![row](https://github.com/user-attachments/assets/1234)";

const comment = (body: string, author = "owner", id = 7001): CommentRecord => ({
	id,
	author,
	createdAt: "2026-09-29T00:00:00Z",
	updatedAt: "2026-09-29T00:00:00Z",
	body,
});

describe("handCheckCommentId", () => {
	it("reads an id or a comment URL", () => {
		expect(handCheckCommentId("7001")).toBe(7001);
		expect(handCheckCommentId("https://forge.example/o/r/pull/6#issuecomment-7001")).toBe(7001);
	});

	it("refuses anything else", () => {
		expect(handCheckCommentId("")).toBeNull();
		expect(handCheckCommentId("abc")).toBeNull();
		expect(handCheckCommentId("https://forge.example/o/r/pull/6")).toBeNull();
	});
});

describe("admitHandCheck", () => {
	it("admits an owner's screenshots naming the head, abbreviated or full", () => {
		for (const named of [HEAD, HEAD.slice(0, 8)]) {
			const found = [comment(`Hand-checked at ${named}.\n\n${SHOT}`)];
			expect(admitHandCheck(7001, found, HEAD, OWNERS)._tag).toBe("Admitted");
		}
	});

	it.each([
		["a comment not on the PR", [comment(`at ${HEAD} ${SHOT}`, "owner", 1)], "not on this PR"],
		["a non-owner's comment", [comment(`at ${HEAD} ${SHOT}`, "agent")], "not on the control plane"],
		["a comment naming another head", [comment(`at 9fe12ab04f ${SHOT}`)], "does not name the head"],
		["a comment with no screenshot", [comment(`looks right at ${HEAD}`)], "no screenshot"],
	])("refuses %s", (_name, comments, reason) => {
		const answer = admitHandCheck(7001, comments, HEAD, OWNERS);
		expect(answer).toMatchObject({_tag: "Inadmissible"});
		if (answer._tag === "Inadmissible") expect(answer.reason).toContain(reason);
	});
});
