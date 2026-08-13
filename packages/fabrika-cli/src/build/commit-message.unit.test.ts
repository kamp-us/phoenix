import {describe, expect, it} from "vitest";
import {scanBody} from "../report/leaks.ts";
import {
	foreignRefsIn,
	isLaneScratchLeaf,
	issueRefsIn,
	leafOf,
	quotedBlock,
	redact,
	subjectOf,
} from "./commit-message.ts";

const DIR = "/var/folders/qq/T/fabrika-build/s-9f2e/5484-c1a4d6f8";

describe("issueRefsIn", () => {
	it("reads every #<n> a message names, subject and body alike", () => {
		expect(
			issueRefsIn("fix(report): state the guarantee (#4789)\n\nGrounded in #4692 and #2038.\n"),
		).toEqual([4789, 4692, 2038]);
	});

	it("names nothing for a message that references no issue", () => {
		expect(issueRefsIn("chore: bump the catalog pin\n")).toEqual([]);
	});

	it("does not read a colour, a heading or a trailing hash as an issue reference", () => {
		expect(issueRefsIn("style: use #fff for the rule\n\n# Notes\n")).toEqual([]);
	});
});

describe("foreignRefsIn", () => {
	// The incident's own commit: the borrowed message named #4789 while the lane served #5437.
	it("names the borrowed message's issue, which the lane never held (#5484)", () => {
		expect(
			foreignRefsIn(
				"fix(report): state the guarantee the eval set delivers (#4789)",
				new Set([5437]),
			),
		).toEqual([4789]);
	});

	it("admits a message that names only this lane's own number", () => {
		expect(foreignRefsIn("fix(build): read the message back (#5484)", new Set([5484]))).toEqual([]);
	});

	it("admits a resume lane's PR number and the issue that PR closes, both", () => {
		expect(
			foreignRefsIn("fix: address the FAIL on #8410 for #5484", new Set([8410, 5484])),
		).toEqual([]);
	});

	it("reports one entry per distinct foreign number, however often it is repeated", () => {
		expect(foreignRefsIn("see #99, and #99 again, and #100", new Set([1]))).toEqual([99, 100]);
	});
});

describe("isLaneScratchLeaf", () => {
	it("admits a plain, UNKEYED leaf in the lane's directory — uniqueness is the directory's", () => {
		expect(isLaneScratchLeaf(`${DIR}/commit-message`, DIR)).toBe(true);
	});

	// AC 4: a keyed leaf name confers nothing. The same nonce in the leaf, one directory up, is still
	// refused — which is what proves the test keys on the directory (§SP rule 2).
	it("refuses a run-KEYED leaf that sits outside the lane's directory", () => {
		expect(
			isLaneScratchLeaf("/var/folders/qq/T/fabrika-build/s-9f2e/commit-msg-5484-c1a4d6f8.txt", DIR),
		).toBe(false);
	});

	it("refuses a hand-rolled path outside the allocator entirely", () => {
		expect(isLaneScratchLeaf("/tmp/msg.txt", DIR)).toBe(false);
	});

	it("refuses a path that descends below the lane's directory", () => {
		expect(isLaneScratchLeaf(`${DIR}/nested/msg.txt`, DIR)).toBe(false);
	});

	it("refuses a traversal that reads as a leaf but is not one", () => {
		expect(isLaneScratchLeaf(`${DIR}/..`, DIR)).toBe(false);
	});

	it("refuses the directory itself, with or without a trailing slash", () => {
		expect(isLaneScratchLeaf(DIR, DIR)).toBe(false);
		expect(isLaneScratchLeaf(`${DIR}/`, DIR)).toBe(false);
	});

	it("refuses a sibling lane's directory whose path merely starts the same way", () => {
		expect(isLaneScratchLeaf(`${DIR}-other/commit-message`, DIR)).toBe(false);
	});

	it("refuses a relative path — the allocator only ever prints absolute ones", () => {
		expect(isLaneScratchLeaf("commit-message", DIR)).toBe(false);
	});
});

describe("redact", () => {
	it("masks the path git names in its own refusal, so a refusal can quote git safely", () => {
		const masked = redact(`fatal: could not read log file '${DIR}/commit-message': No such file`);
		expect(scanBody(masked).leaks).toEqual([]);
		expect(masked).toContain("could not read log file");
	});

	it("leaves text with no machine-local path untouched", () => {
		expect(redact("fatal: nothing to commit")).toBe("fatal: nothing to commit");
	});
});

describe("quotedBlock", () => {
	it("indents each line and redacts, so two blocks read as two quoted messages", () => {
		expect(quotedBlock("subject\n\nbody line\n\n")).toEqual([
			"    subject",
			"    ",
			"    body line",
		]);
	});
});

describe("subjectOf", () => {
	it("is the first non-blank line", () => {
		expect(subjectOf("\n\nfix(build): x\n\nbody\n")).toBe("fix(build): x");
	});
});

describe("leafOf", () => {
	it("is the last segment, which is never a machine-local path on its own", () => {
		expect(leafOf("/Users/someone/secret/msg.txt")).toBe("msg.txt");
		expect(scanBody(leafOf("/Users/someone/secret/msg.txt")).leaks).toEqual([]);
	});
});
