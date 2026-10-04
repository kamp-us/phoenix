import {describe, expect, it} from "vitest";
import type {CommentRecord} from "../io/issues.ts";
import {handCheckNote, isCantSeeNote, noteLines, requireRenderNote} from "./cant-see-note.ts";
import {admitHandCheck} from "./hand-check.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const SUBJECT = {repo: "o/r", pr: 6};

const comment = (body: string, author: string, id: number): CommentRecord => ({
	id,
	author,
	createdAt: "2026-09-29T00:00:00Z",
	updatedAt: "2026-09-29T00:00:00Z",
	body,
});

/** The fenced block of the note: what the owner copies. */
const pasteable = (note: string): string => /```text\n([\s\S]*?)\n```/.exec(note)?.[1] ?? "";

describe("handCheckNote", () => {
	it("carries a comment to paste with the head filled in, admitted once a screenshot replaces the placeholder", () => {
		const pasted = pasteable(handCheckNote(SUBJECT, HEAD, []));
		expect(pasted).toContain(HEAD);
		const posted = pasted.replace(
			/\(replace this line[^)]*\)/,
			"![row](https://github.com/user-attachments/assets/1234)",
		);
		const owners = new Set(["owner"]);
		expect(admitHandCheck(1, [comment(posted, "owner", 1)], HEAD, owners)._tag).toBe("Admitted");
	});

	it("is never its own hand-check when the reviewing account is an owner", () => {
		const note = handCheckNote(SUBJECT, HEAD, []);
		expect(isCantSeeNote(note)).toBe(true);
		expect(admitHandCheck(1, [comment(note, "owner", 1)], HEAD, new Set(["owner"]))).toMatchObject({
			_tag: "Inadmissible",
			fact: "screenshot",
		});
	});

	it("says which fact each near miss failed, linking the comment", () => {
		const note = handCheckNote(SUBJECT, HEAD, [
			{comment: comment("", "owner", 11), fact: "screenshot"},
			{comment: comment("", "agent", 12), fact: "author"},
		]);
		expect(note).toContain(
			"/o/r/pull/6#issuecomment-11) by `owner` names the right commit but has no screenshot image.",
		);
		expect(note).toContain("#issuecomment-12) by `agent`");
		expect(note).toContain("`agent` is not an owner account");
	});

	it("says when an owner account's comment was refused as an agent's", () => {
		const note = handCheckNote(SUBJECT, HEAD, [
			{comment: comment("", "owner", 13), fact: "evidence"},
			{comment: comment("", "owner", 14), fact: "stamp"},
		]);
		expect(note).toContain(
			"#issuecomment-13) by `owner` names the right commit and has a screenshot, but it is the builder's own evidence comment",
		);
		expect(note).toContain(
			"#issuecomment-14) by `owner` names the right commit and has a screenshot, but it carries an agent's stamp",
		);
	});
});

describe("noteLines", () => {
	it("carries the note whole between its two markers", () => {
		const note = requireRenderNote(["apps/site/src/a.tsx"]);
		const lines = noteLines("review-ui route", 6, note);
		const [begin, end] = [lines.indexOf("----- note begins -----"), lines.length - 1];
		expect(lines[end]).toBe("----- note ends -----");
		expect(lines.slice(begin + 1, end).join("\n")).toBe(note);
	});
});
