import {describe, expect, it} from "vitest";
import {
	citedIds,
	decisionBearingText,
	RARITY_FLOOR,
	type SweepCandidate,
	sweep,
	tokenize,
} from "./sweep.ts";

const rec = (id: string, status: string, decision: string): SweepCandidate => ({
	id,
	file: `${id}-slug.md`,
	text: `---\nid: ${id}\ntitle: Title ${id}\nstatus: ${status}\ndate: 2026-01-01\ntags: []\n---\n\n# ${id} — Title ${id}\n\n**What this decides:** gloss ${id}.\n\n## Context\n\nquarantine hexadecimal narwhal context noise.\n\n## Decision\n\n${decision}\n\n## Consequences\n\nnothing.\n`,
});

/** Twelve live records — above the rarity floor — sharing a common word and little else. */
const corpus = (): SweepCandidate[] =>
	Array.from({length: 12}, (_, i) =>
		rec(`01${String(i).padStart(2, "0")}`, "accepted", "the gate is closed"),
	);

describe("decisionBearingText", () => {
	it("takes the title, the gloss and the Decision section — not Context or Consequences", () => {
		const text = decisionBearingText(rec("0100", "accepted", "reticulate the splines").text);
		expect(text).toContain("Title 0100");
		expect(text).toContain("gloss 0100");
		expect(text).toContain("reticulate the splines");
		expect(text).not.toContain("quarantine hexadecimal narwhal");
		expect(text).not.toContain("Consequences");
	});
});

describe("tokenize", () => {
	it("drops stopwords, short tokens and bare numbers", () => {
		expect(tokenize("The gate is 0092 at ok closed")).toEqual(["gate", "closed"]);
	});
});

describe("citedIds", () => {
	it("reads every four-digit reference", () => {
		expect([...citedIds("see ADR 0092 and [0126](0126-x.md)")]).toEqual(["0092", "0126"]);
	});
});

describe("sweep", () => {
	it("is indeterminate below the rarity floor, and says so on the reason channel", () => {
		const result = sweep(
			{id: "0940", text: rec("0940", "proposed", "anything").text},
			corpus().slice(0, 3),
			8,
		);
		expect(result.outcome).toBe("indeterminate");
		expect(result.reason).toContain(String(RARITY_FLOOR));
		expect(result.entries).toEqual([]);
	});

	it("is indeterminate when the subject yields no distinctive terms", () => {
		const result = sweep(
			{id: "0940", text: "---\nstatus: proposed\n---\n\n## Decision\n\n."},
			corpus(),
			8,
		);
		expect(result.outcome).toBe("indeterminate");
		expect(result.reason).toContain("no distinctive terms");
	});

	it("is no-overlap when nothing shares a distinctive term — an answer, not an empty shortlist", () => {
		const subject = rec("0940", "proposed", "marzipan bicycle telemetry");
		const result = sweep({id: "0940", text: subject.text}, corpus(), 8);
		expect(result.outcome).toBe("no-overlap");
		expect(result.entries).toEqual([]);
		expect(result.reason).toContain("not a clearance");
	});

	it("shortlists the records that share the subject's distinctive vocabulary", () => {
		const c = corpus();
		c[0] = rec("0100", "accepted", "reticulate the splines carefully");
		c[1] = rec("0101", "accepted", "reticulate nothing at all");
		const subject = rec("0940", "proposed", "reticulate the splines");
		const result = sweep({id: "0940", text: subject.text}, c, 8);
		expect(result.outcome).toBe("shortlist");
		expect(result.entries.map((e) => e.id)).toEqual(["0100", "0101"]);
		expect(result.entries[0]?.score).toBeGreaterThan(result.entries[1]?.score ?? 0);
		expect(result.entries[0]?.file).toBe("0100-slug.md");
		expect(result.entries[0]?.title).toBe("Title 0100");
	});

	it("excludes non-live records, the subject itself, and anything the subject already cites", () => {
		const c = corpus();
		c[0] = rec("0100", "accepted", "reticulate the splines");
		c[1] = rec("0101", "superseded by [0100](0100-slug.md)", "reticulate the splines");
		c[2] = rec("0102", "accepted", "reticulate the splines");
		const subject = {
			id: "0940",
			text: rec("0940", "proposed", "reticulate the splines, as 0102 already says").text,
		};
		const result = sweep(subject, [...c, rec("0940", "proposed", "reticulate the splines")], 8);
		expect(result.entries.map((e) => e.id)).toEqual(["0100"]);
		expect(result.cited).toBe(1);
	});

	it("caps the shortlist at --limit", () => {
		const c = corpus();
		for (let i = 0; i < 5; i += 1)
			c[i] = rec(`01${String(i).padStart(2, "0")}`, "accepted", "reticulate splines");
		const result = sweep(
			{id: "0940", text: rec("0940", "proposed", "reticulate splines").text},
			c,
			3,
		);
		expect(result.outcome).toBe("shortlist");
		expect(result.entries).toHaveLength(3);
	});

	it("orders ties by id ascending, so two runs never disagree", () => {
		const c = corpus();
		for (let i = 0; i < 5; i += 1)
			c[i] = rec(`01${String(i).padStart(2, "0")}`, "accepted", "reticulate splines");
		const result = sweep(
			{id: "0940", text: rec("0940", "proposed", "reticulate splines").text},
			c,
			8,
		);
		expect(result.entries.map((e) => e.id)).toEqual([...result.entries.map((e) => e.id)].sort());
	});
});
