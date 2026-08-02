import {describe, expect, it} from "vitest";
import {errOut, fakeExec, okOut} from "../fakes.test-support.ts";
import {
	claimedIdOf,
	idsClaimedByPr,
	openPullRequests,
	parseFileRows,
	parsePrNumbers,
} from "./github.ts";

describe("parsePrNumbers — shape before interpretation", () => {
	it("reads a list of numbers", () => {
		expect(parsePrNumbers("11\n12\n")).toEqual([11, 12]);
	});

	it("reads an empty list as an empty FACT, not a failure", () => {
		expect(parsePrNumbers("")).toEqual([]);
	});

	it("returns null on output that is not numbers — a 0 exit with the wrong bytes is UNKNOWN", () => {
		expect(parsePrNumbers("null\n")).toBeNull();
		expect(parsePrNumbers('{"message":"Not Found"}')).toBeNull();
	});
});

describe("parseFileRows — shape before interpretation", () => {
	it("reads status/filename rows", () => {
		expect(parseFileRows("added\ta.md\nmodified\tb.md\n")).toEqual([
			{status: "added", filename: "a.md"},
			{status: "modified", filename: "b.md"},
		]);
	});

	it("returns null on a row with no tab", () => {
		expect(parseFileRows("a.md\n")).toBeNull();
	});

	it("returns null on an unknown status word", () => {
		expect(parseFileRows("teleported\ta.md\n")).toBeNull();
	});
});

describe("claimedIdOf", () => {
	it("reads the id a .decisions path claims", () => {
		expect(claimedIdOf(".decisions/0239-campaign-milestones.md", ".decisions")).toEqual({
			id: "0239",
			file: "0239-campaign-milestones.md",
		});
	});

	it("ignores a path outside the record directory or nested under it", () => {
		expect(claimedIdOf("docs/0239-x.md", ".decisions")).toBeNull();
		expect(claimedIdOf(".decisions/sub/0239-x.md", ".decisions")).toBeNull();
		expect(claimedIdOf(".decisions/index.md", ".decisions")).toBeNull();
	});
});

describe("openPullRequests", () => {
	it("refuses when gh fails", () => {
		const result = openPullRequests(
			fakeExec([[/gh api/, errOut("HTTP 404")]]),
			"kamp-us/nonexistent",
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses when gh exits 0 with output of the wrong shape", () => {
		const result = openPullRequests(
			fakeExec([[/gh api/, okOut("not-a-number\n")]]),
			"kamp-us/phoenix",
		);
		expect(result._tag).toBe("Failure");
	});

	it("pages — the request asks for the full set, not the first page", () => {
		let seen = "";
		const exec = (file: string, args: ReadonlyArray<string>) => {
			seen = [file, ...args].join(" ");
			return okOut("1\n");
		};
		openPullRequests(exec, "kamp-us/phoenix");
		expect(seen).toContain("--paginate");
		expect(seen).toContain("per_page=100");
	});
});

describe("idsClaimedByPr", () => {
	it("counts only ADDED record files", () => {
		const exec = fakeExec([
			[
				/files/,
				okOut("added\t.decisions/0239-x.md\nmodified\t.decisions/0126-y.md\nadded\tREADME.md\n"),
			],
		]);
		const result = idsClaimedByPr(exec, "kamp-us/phoenix", 4711, ".decisions");
		expect(result).toEqual({_tag: "Ok", value: [{id: "0239", file: "0239-x.md", pr: 4711}]});
	});

	it("refuses rather than returning a short list when the read fails", () => {
		const result = idsClaimedByPr(
			fakeExec([[/files/, errOut("HTTP 502")]]),
			"kamp-us/phoenix",
			1,
			".decisions",
		);
		expect(result._tag).toBe("Failure");
	});
});
