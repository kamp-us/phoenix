import {describe, expect, it} from "vitest";
import {
	type ChildRecord,
	EXCLUDE_ENTRY,
	parseManifest,
	parseRunRecord,
	renderManifest,
	renderRunRecord,
	runDir,
	runKey,
	runKeyNonce,
} from "./run.ts";

const CHILD: ChildRecord = {
	number: 4301,
	id: 90210,
	title: "queue view",
	type: "type:feature",
	priority: "p1",
	readyFor: "agent",
	stories: [1, 2],
	containment: "flag",
	linked: true,
	mintedThisRun: true,
};

describe("the run key", () => {
	/** The key is the claim nonce, never the session: sibling subagents share the session id (#4500). */
	it("is the epic and the claim nonce", () => {
		expect(runKey(4300, "c1a4d6f8")).toBe("4300-c1a4d6f8");
		expect(runDir("/w/", "4300-c1a4d6f8")).toBe("/w/.fabrika-plan/4300-c1a4d6f8");
	});

	it("excludes its own root from the tree", () => {
		expect(EXCLUDE_ENTRY).toBe(".fabrika-plan/");
	});

	it("keys a succession on the adopt token's nonce, never the dead lane's (#7010)", () => {
		expect(runKeyNonce("build:s-gone:9f3c7a21-5d44", "build:s-heir:b2ee7f04-8a19")).toBe(
			"b2ee7f04",
		);
	});

	it("keys an ordinary claim on the winning marker's own token", () => {
		expect(runKeyNonce("build:s-9f2e:c1a4d6f8-3b7e", null)).toBe("c1a4d6f8");
	});

	it("falls back to the marker when the adopt token is unparseable, and nulls when neither reads", () => {
		expect(runKeyNonce("build:s-9f2e:c1a4d6f8-3b7e", "not-a-token")).toBe("c1a4d6f8");
		expect(runKeyNonce("garbage", "also-garbage")).toBeNull();
	});
});

describe("run.json", () => {
	it("round-trips", () => {
		const record = {
			epic: 4300,
			run: "4300-c1a4d6f8",
			mode: "fresh" as const,
			cycleDoc: "present" as const,
			bodyDigest: "8f2c1a90b4d7",
		};
		expect(parseRunRecord(renderRunRecord(record))).toEqual(record);
	});

	/** An unparseable record is UNKNOWN, never a default `fresh`. */
	it("refuses a record whose mode is off its closed set", () => {
		expect(
			parseRunRecord('{"epic":1,"run":"x","mode":"maybe","cycleDoc":"present","bodyDigest":"a"}'),
		).toBeNull();
	});

	it("refuses bytes that are not JSON at all", () => {
		expect(parseRunRecord("not json")).toBeNull();
	});
});

describe("children.jsonl", () => {
	it("round-trips one record per line", () => {
		expect(parseManifest(renderManifest([CHILD, {...CHILD, number: 4302, id: 90211}]))).toEqual([
			CHILD,
			{...CHILD, number: 4302, id: 90211},
		]);
	});

	it("renders nothing for an empty child set, and reads it back as one", () => {
		expect(renderManifest([])).toBe("");
		expect(parseManifest("")).toEqual([]);
	});

	/** A line that will not parse fails the read; it never resolves to "this run has no children". */
	it("refuses a manifest with one broken line", () => {
		expect(parseManifest(`${renderManifest([CHILD])}not a record\n`)).toBeNull();
	});

	it("refuses a record with no id — the link and unlink are keyed on it", () => {
		expect(parseManifest('{"number":4301,"title":"x"}\n')).toBeNull();
	});
});
