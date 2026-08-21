/** The lane key — which kind an argument names, where it lands, and the names it refuses. */
import {describe, expect, it} from "vitest";
import {CHORE_NAME_LIMIT, laneRef, parseKey, templateFile} from "./key.ts";
import {DEFAULT_CHORES_ROOT, DEFAULT_LANES_ROOT} from "./store.ts";

const key = (raw: string) => {
	const parsed = parseKey(raw);
	if (parsed._tag !== "Key") throw new Error(`refused "${raw}": ${parsed.reason}`);
	return parsed.key;
};

const reasonFor = (raw: string): string => {
	const parsed = parseKey(raw);
	expect(parsed._tag).toBe("Malformed");
	return parsed._tag === "Malformed" ? parsed.reason : "";
};

describe("the lane key", () => {
	it("reads a bare argument as the issue lane it drives", () => {
		expect(key("5673")).toEqual({_tag: "Issue", lane: "5673"});
		expect(laneRef(key("5673"), null)).toEqual({root: DEFAULT_LANES_ROOT, lane: "5673"});
	});

	it("reads a `chore:` argument as a chore lane under the chores root", () => {
		expect(key("chore:park-sweep")).toEqual({_tag: "Chore", name: "park-sweep"});
		expect(laneRef(key("chore:park-sweep"), null)).toEqual({
			root: DEFAULT_CHORES_ROOT,
			lane: "park-sweep",
		});
	});

	it("lets an explicit root win over either kind's default", () => {
		expect(laneRef(key("5673"), "/tmp/lanes").root).toBe("/tmp/lanes");
		expect(laneRef(key("chore:park-sweep"), "/tmp/lanes").root).toBe("/tmp/lanes");
	});

	it("selects the boot template by kind, never by root", () => {
		expect(templateFile(key("5673")._tag)).toBe("coder.workflow.json");
		expect(templateFile(key("chore:park-sweep")._tag)).toBe("chore.workflow.json");
	});

	it("refuses a chore name that is not lowercase kebab", () => {
		for (const raw of ["chore:", "chore:Park-Sweep", "chore:park sweep", "chore:park_sweep"]) {
			expect(reasonFor(raw)).toContain("lowercase kebab");
		}
	});

	it("refuses a chore name carrying a separator or a traversal, before any path is joined", () => {
		for (const raw of ["chore:../../etc", "chore:a/b", "chore:.", "chore:park-sweep/"]) {
			expect(parseKey(raw)._tag).toBe("Malformed");
		}
	});

	it("refuses a chore name past the length limit", () => {
		const long = `chore:${"a".repeat(CHORE_NAME_LIMIT + 1)}`;

		expect(reasonFor(long)).toContain(String(CHORE_NAME_LIMIT));
		expect(parseKey(`chore:${"a".repeat(CHORE_NAME_LIMIT)}`)._tag).toBe("Key");
	});

	it("refuses an empty key rather than resolving it to the root itself", () => {
		expect(reasonFor("")).toContain("empty");
	});
});
