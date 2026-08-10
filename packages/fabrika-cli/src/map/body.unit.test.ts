import {describe, expect, it} from "vitest";
import {normalizeForReadback} from "../report/compose.ts";
import {
	bulletEntries,
	digestOf,
	digestOfBody,
	parseBody,
	renderFrontierRow,
	renderMintBody,
	renderOutOfScope,
	spliceSection,
} from "./body.ts";
import {MAP_BODY, MAP_BODY_WITH_REJECTION, parsed} from "./fixtures.test-support.ts";

describe("parseBody", () => {
	it("reads the five sections, their entries and the fog count", () => {
		const body = parsed(MAP_BODY);
		expect(body.destination).toBe("how moderation weight is earned");
		expect(body.frontier).toEqual([
			{
				ticket: 9142,
				kind: "research",
				question: "which table carries the per-account weight column?",
				forkedTo: null,
			},
		]);
		expect(body.fog).toBe(1);
		expect(body.decisions).toEqual([]);
		expect(body.outOfScope).toEqual([]);
	});

	it("treats an empty section as well-formed — a freshly minted map must stay readable", () => {
		const read = parseBody(renderMintBody("how weight is earned", []));
		expect(read._tag).toBe("Parsed");
	});

	it("refuses a body whose sections are out of order, naming what it found", () => {
		const read = parseBody(
			"## Frontier\n\n## Destination\n\n## Decisions\n\n## Fog\n\n## Out of scope\n",
		);
		expect(read._tag).toBe("Malformed");
		expect(read._tag === "Malformed" && read.reason).toContain("Frontier, Destination");
	});

	it("refuses a decision entry that cites no authority", () => {
		const read = parseBody(
			MAP_BODY.replace("## Decisions\n", "## Decisions\n- weight is earned per account\n"),
		);
		expect(read._tag === "Malformed" && read.reason).toContain("cites no authority");
	});

	it("reads both decision citations", () => {
		const body = parsed(
			MAP_BODY.replace(
				"## Decisions\n",
				"## Decisions\n- weight is earned per account — ruled on #9301 R2.3\n- the audit log records it — from #9146\n",
			),
		);
		expect(body.decisions.map((entry) => entry.authority)).toEqual([
			{_tag: "Ruled", session: 9301, questionId: "R2.3"},
			{_tag: "Finding", ticket: 9146},
		]);
	});

	it("reads a forked frontier row's route without folding it into the question", () => {
		const body = parsed(
			MAP_BODY.replace(
				"- #9142 · research — which table carries the per-account weight column?",
				"- #9144 · decision — does an invited çaylak start at 0 karma? — forked to #9301",
			),
		);
		expect(body.frontier[0]).toEqual({
			ticket: 9144,
			kind: "decision",
			question: "does an invited çaylak start at 0 karma?",
			forkedTo: 9301,
		});
	});

	it("refuses a frontier row whose kind is off the closed set", () => {
		const read = parseBody(MAP_BODY.replace("· research —", "· investigation —"));
		expect(read._tag === "Malformed" && read.reason).toContain("is not");
	});

	it("reads an out-of-scope entry and its date", () => {
		expect(parsed(MAP_BODY_WITH_REJECTION).outOfScope).toEqual([
			{
				direction: "a per-topic weight multiplier",
				reason: "It makes every moderation action's authority unreadable without a topic lookup",
				recordedAt: "2026-06-29",
			},
		]);
	});
});

describe("bulletEntries", () => {
	it("folds a wrapped continuation back onto its entry", () => {
		expect(bulletEntries("- one\n  and its tail\n- two")).toEqual(["one and its tail", "two"]);
	});

	it("refuses a line that is neither an entry nor a continuation", () => {
		expect(bulletEntries("not a bullet")).toBeNull();
	});
});

describe("digestOf", () => {
	it("is twelve lowercase hex characters", () => {
		expect(digestOfBody(parsed(MAP_BODY))).toMatch(/^[0-9a-f]{12}$/);
	});

	it("survives a normalizeForReadback round trip byte-identically", () => {
		const before = digestOfBody(parsed(MAP_BODY));
		const after = digestOfBody(parsed(`${normalizeForReadback(MAP_BODY)}\n`));
		expect(after).toBe(before);
	});

	it("ignores a heading's trailing whitespace, which no verb writes", () => {
		const spaced = MAP_BODY.replace("## Frontier", "## Frontier  ");
		expect(digestOfBody(parsed(spaced))).toBe(digestOfBody(parsed(MAP_BODY)));
	});

	it("moves when any section body moves", () => {
		expect(digestOf(["a", "", "", "", ""])).not.toBe(digestOf(["a", "b", "", "", ""]));
	});
});

describe("spliceSection", () => {
	it("changes one section and copies every other byte verbatim", () => {
		const body = parsed(MAP_BODY);
		const next = spliceSection(body, "Decisions", "- weight is earned per account — from #9146");
		expect(next).toContain("- weight is earned per account — from #9146");
		expect(next).toContain("- what clock does weight decay on?");
		expect(parsed(next).frontier).toEqual(body.frontier);
	});

	it("re-imposes the blank line so a first write to an empty section stays parseable", () => {
		const next = spliceSection(
			parsed(MAP_BODY),
			"Out of scope",
			renderOutOfScope({
				direction: "a per-topic weight multiplier",
				reason: "it makes authority unreadable",
				recordedAt: "2026-08-10",
			}),
		);
		expect(parseBody(next)._tag).toBe("Parsed");
		expect(parsed(next).outOfScope).toHaveLength(1);
	});

	it("empties a section without collapsing the body", () => {
		const next = spliceSection(parsed(MAP_BODY), "Frontier", "");
		expect(parsed(next).frontier).toEqual([]);
		expect(parsed(next).fog).toBe(1);
	});
});

describe("renderFrontierRow", () => {
	it("round-trips through the parser", () => {
		const row = {
			ticket: 9144,
			kind: "decision" as const,
			question: "does it decay?",
			forkedTo: 9301,
		};
		const next = spliceSection(parsed(MAP_BODY), "Frontier", renderFrontierRow(row));
		expect(parsed(next).frontier).toEqual([row]);
	});
});
