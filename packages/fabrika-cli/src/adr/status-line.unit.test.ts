import {describe, expect, it} from "vitest";
import {diffBeyondStatusLine, nextStatusValue, parseLinks, rewriteStatus} from "./status-line.ts";

const file = (status: string, body = "## Decision\n\n**A thing.**\n"): string =>
	`---\nid: 0023\ntitle: A title\nstatus: ${status}\ndate: 2026-01-01\ntags: []\n---\n\n# 0023 — A title\n\n${body}`;

const by = {id: "0240", file: "0240-only-landed-adrs-may-be-cited.md"};

describe("nextStatusValue", () => {
	it("orders an out-of-order append by id, not by arrival", () => {
		const existing = "amended-in-part by [0037](0037-c.md), [0025](0025-a.md)";
		expect(nextStatusValue("amend-in-part", existing, {id: "0028", file: "0028-b.md"})).toBe(
			"amended-in-part by [0025](0025-a.md), [0028](0028-b.md), [0037](0037-c.md)",
		);
	});
});

describe("parseLinks", () => {
	it("reads every link in order", () => {
		expect(parseLinks("amended-in-part by [0025](0025-a.md), [0028](0028-b.md)")).toEqual([
			{id: "0025", file: "0025-a.md"},
			{id: "0028", file: "0028-b.md"},
		]);
	});
});

describe("diffBeyondStatusLine — the assertion the implementation owes", () => {
	const lines = ["---", "id: 0023", "status: accepted", "---", "", "body"];
	const before = lines.join("\n");
	const rewrite = (mutate: (l: string[]) => void, newline = "\n"): string => {
		const l = [...lines];
		l[2] = "status: superseded by [0240](0240-x.md)";
		mutate(l);
		return l.join(newline);
	};

	it("is null when only the status line moved", () => {
		expect(
			diffBeyondStatusLine(
				before,
				rewrite(() => {}),
				2,
			),
		).toBeNull();
	});

	it("counts a second edited line — this is what aborts the write with exit 15", () => {
		expect(
			diffBeyondStatusLine(
				before,
				rewrite((l) => {
					l[5] = "body, silently rewritten";
				}),
				2,
			),
		).toBe(1);
	});

	it("counts a dropped line, so a rewrite that loses text cannot pass", () => {
		expect(diffBeyondStatusLine(before, lines.slice(0, -1).join("\n"), 2)).toBe(1);
	});

	it("counts a LINE-ENDING change — the blind spot a post-split array comparison cannot see", () => {
		expect(
			diffBeyondStatusLine(
				before,
				rewrite(() => {}, "\r\n"),
				2,
			),
		).toBe(4);
	});
});

describe("rewriteStatus — the one-line-diff invariant", () => {
	it("preserves the trailing newline", () => {
		const outcome = rewriteStatus("supersede", file("accepted"), by);
		expect(outcome._tag === "Rewritten" && outcome.text.endsWith("**A thing.**\n")).toBe(true);
	});

	it("refuses a file with two frontmatter status lines — ambiguous, not resolvable", () => {
		const two = "---\nid: 0023\nstatus: accepted\nstatus: proposed\n---\n\nbody\n";
		expect(rewriteStatus("supersede", two, by)._tag).toBe("NoSingleStatusLine");
	});

	it("does not treat a body `status:` line as the frontmatter one", () => {
		const outcome = rewriteStatus("supersede", file("accepted", "status: not frontmatter\n"), by);
		expect(outcome._tag).toBe("Rewritten");
		if (outcome._tag !== "Rewritten") return;
		expect(outcome.text).toContain("status: not frontmatter");
	});

	it("an unreadable (empty) input resolves to a refusal, never a written file", () => {
		expect(rewriteStatus("supersede", "", by)._tag).toBe("NoSingleStatusLine");
	});
});
