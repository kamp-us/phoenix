import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
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
	it("refuses when gh fails", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				openPullRequests("kamp-us/nonexistent"),
				fakeShell([[/gh api/, errOut("HTTP 404")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});

	it("refuses when gh exits 0 with output of the wrong shape", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				openPullRequests("kamp-us/phoenix"),
				fakeShell([[/gh api/, okOut("not-a-number\n")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});

	it("pages — the request asks for the full set, not the first page", async () => {
		const shell = fakeShell([[/gh api/, okOut("1\n")]]);
		await Effect.runPromise(Effect.provide(openPullRequests("kamp-us/phoenix"), shell.layer));
		expect(shell.calls[0]).toContain("--paginate");
		expect(shell.calls[0]).toContain("per_page=100");
	});
});

describe("idsClaimedByPr", () => {
	it("counts only ADDED record files", async () => {
		const shell = fakeShell([
			[
				/files/,
				okOut("added\t.decisions/0239-x.md\nmodified\t.decisions/0126-y.md\nadded\tREADME.md\n"),
			],
		]);
		const result = await Effect.runPromise(
			Effect.provide(idsClaimedByPr("kamp-us/phoenix", 4711, ".decisions"), shell.layer),
		);
		expect(result).toEqual({_tag: "Ok", value: [{id: "0239", file: "0239-x.md", pr: 4711}]});
	});

	it("refuses rather than returning a short list when the read fails", async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				idsClaimedByPr("kamp-us/phoenix", 1, ".decisions"),
				fakeShell([[/files/, errOut("HTTP 502")]]).layer,
			),
		);
		expect(result._tag).toBe("Failure");
	});
});
