import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {admitHandCheck, findHandCheck, handCheckCommentId, nearMisses} from "./hand-check.ts";

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

describe("findHandCheck", () => {
	it("finds the newest admissible hand-check, passing over the ones that fail a fact", () => {
		const older = comment(`at ${HEAD} ${SHOT}`, "owner", 1);
		const newer = {...comment(`at ${HEAD} ${SHOT}`, "owner", 2), updatedAt: "2026-09-29T01:00:00Z"};
		const agent = {...comment(`at ${HEAD} ${SHOT}`, "agent", 3), updatedAt: "2026-09-29T02:00:00Z"};
		expect(findHandCheck([older, newer, agent], HEAD, OWNERS)?.id).toBe(2);
	});

	it("finds none where no comment passes all four facts", () => {
		const found = [comment(`looks right at ${HEAD}`), comment(`at 9fe12ab04f ${SHOT}`, "owner", 2)];
		expect(findHandCheck(found, HEAD, OWNERS)).toBeNull();
	});
});

describe("nearMisses", () => {
	it("names the one fact a head-naming comment failed, and passes over the rest", () => {
		const found = [
			comment(`looks right at ${HEAD.slice(0, 8)}`, "owner", 1),
			comment(`at ${HEAD} ${SHOT}`, "agent", 2),
			comment(`gate note citing ${HEAD}`, "agent", 3),
			comment(`at 9fe12ab04f ${SHOT}`, "owner", 4),
			comment(`at ${HEAD} ${SHOT}`, "owner", 5),
		];
		expect(
			nearMisses(found, HEAD, OWNERS).map((miss) => [miss.comment.id, miss.fact]),
		).toStrictEqual([
			[1, "screenshot"],
			[2, "author"],
		]);
	});
});
