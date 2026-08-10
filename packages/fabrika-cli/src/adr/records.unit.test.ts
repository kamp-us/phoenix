import {describe, expect, it} from "vitest";
import {
	frontmatterBlock,
	idFromFile,
	isFourDigitId,
	isKebabSlug,
	isLive,
	isSuperseded,
	partitionRecordNames,
	sortIds,
	statusOf,
	titleOf,
} from "./records.ts";

describe("idFromFile", () => {
	it("reads the NNNN prefix", () => {
		expect(idFromFile("0240-only-landed-adrs-may-be-cited.md")).toBe("0240");
	});

	it("keeps the letter suffix the real corpus carries", () => {
		expect(idFromFile("0034a-live-fan-out-options-considered.md")).toBe("0034a");
	});

	it("is null for a name that is not a record", () => {
		expect(idFromFile("index.md")).toBeNull();
		expect(idFromFile("0240.md")).toBeNull();
		expect(idFromFile("0240-Not_Kebab.md")).toBeNull();
	});
});

describe("partitionRecordNames", () => {
	it("keeps records, ignores non-records, and surfaces malformed ones", () => {
		const {records, unparseable} = partitionRecordNames([
			"0002-b.md",
			"0001-a.md",
			"index.md",
			"README.md",
			"12-too-short.md",
		]);
		expect(records).toEqual(["0001-a.md", "0002-b.md"]);
		expect(unparseable).toEqual(["12-too-short.md"]);
	});

	it("is empty for an empty listing — the caller reads that as a fresh corpus", () => {
		expect(partitionRecordNames([]).records).toEqual([]);
	});
});

describe("isLive", () => {
	it("counts accepted and amended-in-part as live", () => {
		expect(isLive("accepted")).toBe(true);
		expect(isLive("amended-in-part")).toBe(true);
		expect(isLive("amended-in-part by [0025](0025-x.md), [0028](0028-y.md)")).toBe(true);
	});

	it("counts everything present-but-not-authoritative as not live", () => {
		for (const status of [
			"proposed",
			"superseded",
			"superseded-in-part",
			"retired",
			"moot",
			"reference",
		]) {
			expect(isLive(status)).toBe(false);
		}
	});

	it("treats an unreadable status as not live", () => {
		expect(isLive("")).toBe(false);
	});
});

describe("isSuperseded", () => {
	it("matches the superseded-by form", () => {
		expect(isSuperseded("superseded by [0240](0240-x.md)")).toBe(true);
		expect(isSuperseded("superseded")).toBe(true);
	});

	it("does not match superseded-in-part or an amend list", () => {
		expect(isSuperseded("superseded-in-part by [0240](0240-x.md)")).toBe(false);
		expect(isSuperseded("amended-in-part by [0240](0240-x.md)")).toBe(false);
	});
});

describe("frontmatter", () => {
	const text = `---
id: 0023
title: Live views ride an SSE protocol
status: amended-in-part by [0025](0025-x.md), [0028](0028-y.md)
date: 2026-01-01
---

body`;

	it("reads the status verbatim, inline markdown and all", () => {
		expect(statusOf(text)).toBe("amended-in-part by [0025](0025-x.md), [0028](0028-y.md)");
	});

	it("reads the title verbatim", () => {
		expect(titleOf(text)).toBe("Live views ride an SSE protocol");
	});

	it("returns null for a file with no frontmatter — never a defaulted status", () => {
		expect(frontmatterBlock("no fences here")).toBeNull();
		expect(statusOf("no fences here")).toBeNull();
	});

	it("unquotes a quoted scalar", () => {
		expect(statusOf('---\nstatus: "quoted \\"inner\\""\n---\n')).toBe('quoted "inner"');
	});
});

describe("argument shapes", () => {
	it("accepts only four zero-padded digits as an id", () => {
		expect(isFourDigitId("0240")).toBe(true);
		expect(isFourDigitId("240")).toBe(false);
		expect(isFourDigitId("0034a")).toBe(false);
	});

	it("accepts only kebab-case as a slug", () => {
		expect(isKebabSlug("only-landed-adrs-may-be-cited")).toBe(true);
		expect(isKebabSlug("Only-Landed")).toBe(false);
		expect(isKebabSlug("double--hyphen")).toBe(false);
		expect(isKebabSlug("-leading")).toBe(false);
	});
});

describe("sortIds", () => {
	it("orders numerically, then by letter suffix", () => {
		expect(sortIds(["0100", "0034a", "0009", "0034"])).toEqual(["0009", "0034", "0034a", "0100"]);
	});
});
