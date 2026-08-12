import {describe, expect, it} from "vitest";
import {diffBeyondStatusLine, nextStatusValue, parseLinks, rewriteStatus} from "./status-line.ts";

const file = (status: string, body = "## Decision\n\n**A thing.**\n"): string =>
	`---\nid: 0023\ntitle: A title\nstatus: ${status}\ndate: 2026-01-01\ntags: []\n---\n\n# 0023 — A title\n\n${body}`;

const by = {id: "0940", file: "0940-only-landed-adrs-may-be-cited.md"};

describe("nextStatusValue", () => {
	it("supersede replaces whatever was there", () => {
		expect(nextStatusValue("supersede", "accepted", by)).toBe(
			"superseded by [0940](0940-only-landed-adrs-may-be-cited.md)",
		);
	});

	it("amend-in-part APPENDS to an existing list, in id order, preserving every live link", () => {
		const existing =
			"amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md)";
		expect(nextStatusValue("amend-in-part", existing, by)).toBe(
			`${existing}, [0940](0940-only-landed-adrs-may-be-cited.md)`,
		);
	});

	it("orders an out-of-order append by id, not by arrival", () => {
		const existing = "amended-in-part by [0037](0037-c.md), [0025](0025-a.md)";
		expect(nextStatusValue("amend-in-part", existing, {id: "0028", file: "0028-b.md"})).toBe(
			"amended-in-part by [0025](0025-a.md), [0028](0028-b.md), [0037](0037-c.md)",
		);
	});

	it("re-adding a link already in the list is a no-op", () => {
		const existing = "amended-in-part by [0940](0940-only-landed-adrs-may-be-cited.md)";
		expect(nextStatusValue("amend-in-part", existing, by)).toBe(existing);
	});

	it("amend-in-part over a plain accepted status starts the list", () => {
		expect(nextStatusValue("amend-in-part", "accepted", by)).toBe(
			"amended-in-part by [0940](0940-only-landed-adrs-may-be-cited.md)",
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
		l[2] = "status: superseded by [0940](0940-x.md)";
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
	it("changes the status line and NOTHING else", () => {
		const before = file("accepted");
		const outcome = rewriteStatus("supersede", before, by);
		expect(outcome._tag).toBe("Rewritten");
		if (outcome._tag !== "Rewritten") return;
		const a = before.split("\n");
		const b = outcome.text.split("\n");
		expect(b.length).toBe(a.length);
		expect(a.filter((line, i) => line !== b[i])).toHaveLength(1);
		expect(b[3]).toBe("status: superseded by [0940](0940-only-landed-adrs-may-be-cited.md)");
	});

	it("preserves the trailing newline", () => {
		const outcome = rewriteStatus("supersede", file("accepted"), by);
		expect(outcome._tag === "Rewritten" && outcome.text.endsWith("**A thing.**\n")).toBe(true);
	});

	it("refuses a file with no frontmatter status line", () => {
		expect(rewriteStatus("supersede", "# no frontmatter\n", by)._tag).toBe("NoSingleStatusLine");
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

	it("refuses to amend or re-supersede a superseded record", () => {
		expect(rewriteStatus("amend-in-part", file("superseded by [0100](0100-x.md)"), by)._tag).toBe(
			"AlreadySuperseded",
		);
		expect(rewriteStatus("supersede", file("superseded by [0100](0100-x.md)"), by)._tag).toBe(
			"AlreadySuperseded",
		);
	});

	it("an unreadable (empty) input resolves to a refusal, never a written file", () => {
		expect(rewriteStatus("supersede", "", by)._tag).toBe("NoSingleStatusLine");
	});
});
