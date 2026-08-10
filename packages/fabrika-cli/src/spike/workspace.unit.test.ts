import {describe, expect, it} from "vitest";
import {
	evidenceRecord,
	manifest,
	manifestText,
	ONE_RUN,
	ONE_RUN_DIGEST,
} from "./fixtures.test-support.ts";
import {
	EMPTY_SHA256,
	evidenceDigestOf,
	isInsideTree,
	isNonce,
	parseEvidence,
	parseManifest,
	renderEvidenceLine,
	renderManifest,
	treeDigestOf,
	workspacePath,
} from "./workspace.ts";

describe("the workspace path is keyed on the nonce alone", () => {
	it("puts two concurrent runs in two directories", () => {
		expect(workspacePath("/tmp", "7f3a9c21")).toBe("/tmp/fabrika-spike/7f3a9c21");
		expect(workspacePath("/tmp", "0badf00d")).not.toBe(workspacePath("/tmp", "7f3a9c21"));
	});

	it("admits only eight lowercase hex as a nonce", () => {
		expect(isNonce("7f3a9c21")).toBe(true);
		expect(isNonce("7F3A9C21")).toBe(false);
		expect(isNonce("run-1")).toBe(false);
		expect(isNonce("7f3a9c2")).toBe(false);
	});
});

describe("the in-tree test compares resolved paths", () => {
	it("refuses a workspace at the tree root and under it", () => {
		expect(isInsideTree("/repo", "/repo")).toBe(true);
		expect(isInsideTree("/repo/tmp/fabrika-spike/7f3a9c21", "/repo")).toBe(true);
	});

	it("admits a sibling whose name merely starts with the root", () => {
		expect(isInsideTree("/repo-two/fabrika-spike/7f3a9c21", "/repo")).toBe(false);
	});
});

describe("the manifest is refused whole-file", () => {
	it("round-trips a well-formed one", () => {
		const parsed = parseManifest(manifestText());
		expect(parsed).toEqual({_tag: "Parsed", value: manifest()});
	});

	it.each([
		["a missing key", '{"nonce":"7f3a9c21"}'],
		["an extra key", renderManifest(manifest()).replace(/}\n$/, ',"extra":1}\n')],
		["an off-enum kind", manifestText().replace('"logic"', '"prototype"')],
		["an off-grammar nonce", manifestText().replace('"7f3a9c21"', '"run-1"')],
		["text that is not JSON", "not json\n"],
	])("refuses %s", (_case, text) => {
		expect(parseManifest(text)._tag).toBe("Malformed");
	});

	it("admits the provisional window, where the spike is null", () => {
		expect(parseManifest(manifestText({spike: null}))._tag).toBe("Parsed");
	});
});

describe("the evidence log is pinned, so its digest is reproducible", () => {
	it("serializes the keys in one order with no whitespace", () => {
		expect(renderEvidenceLine(evidenceRecord(1))).toBe(
			`{"seq":1,"command":["printf","no\\\\n"],"commandExit":0,"timedOut":false,"outBytes":3,"errBytes":0,"truncated":false,"outSha256":"${evidenceRecord(1).outSha256}","errSha256":"${EMPTY_SHA256}"}\n`,
		);
	});

	it("digests exactly the bytes on disk", () => {
		expect(evidenceDigestOf(ONE_RUN)).toBe(ONE_RUN_DIGEST);
	});

	it("reads a two-line log", () => {
		const text = [evidenceRecord(1), evidenceRecord(2)].map(renderEvidenceLine).join("");
		const parsed = parseEvidence(text);
		expect(parsed._tag).toBe("Parsed");
		expect(parsed._tag === "Parsed" ? parsed.value.length : 0).toBe(2);
	});

	it.each([
		["a line that does not parse", "not json\n"],
		[
			"seq values that are not contiguous from 1",
			[evidenceRecord(1), evidenceRecord(3)].map(renderEvidenceLine).join(""),
		],
		["a missing key", '{"seq":1}\n'],
	])("refuses %s", (_case, text) => {
		expect(parseEvidence(text)._tag).toBe("Malformed");
	});

	it("reads an empty log as zero records — the caller decides absent versus empty", () => {
		expect(parseEvidence("")).toEqual({_tag: "Parsed", value: []});
	});
});

describe("treeDigest is defined so two implementers compute one number", () => {
	it("digests a clean tree to the SHA-256 of zero bytes", () => {
		expect(treeDigestOf("")).toBe(EMPTY_SHA256);
		expect(EMPTY_SHA256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("sorts byte-wise, so line order out of git cannot move the digest", () => {
		expect(treeDigestOf("?? b\n?? a\n")).toBe(treeDigestOf("?? a\n?? b\n"));
	});

	it("moves the moment one ignored path appears", () => {
		expect(treeDigestOf("!! node_modules/\n")).not.toBe(EMPTY_SHA256);
	});
});
