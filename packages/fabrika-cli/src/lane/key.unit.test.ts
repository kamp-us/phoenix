/** The lane key — which kind an argument names, where it lands, and the names it refuses. */
import {describe, expect, it} from "vitest";
import {claimTarget} from "./claim.ts";
import {
	CHORE_NAME_LIMIT,
	keyIssue,
	laneRef,
	parseKey,
	rawKeyIssue,
	resolveKeyIssue,
	resolveRawIssue,
	templateFile,
} from "./key.ts";
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

describe("the issue a lane key drives", () => {
	it("reads a bare numeric key as the issue itself", () => {
		expect(keyIssue(key("8012"))).toBe(8012);
		expect(rawKeyIssue("8012")).toBe(8012);
	});

	it("reads the leading segment of a quarantined key, not the whole directory name", () => {
		expect(keyIssue(key("8012.frozen-deadlock-20260905T194736"))).toBe(8012);
		expect(rawKeyIssue("7981.frozen-deadlock-1788645453")).toBe(7981);
	});

	it("resolves a chore key to no issue at all", () => {
		expect(keyIssue(key("chore:park-sweep"))).toBeNull();
		expect(rawKeyIssue("chore:park-sweep")).toBeNull();
	});

	it("resolves a key with no leading numeric segment to no issue", () => {
		for (const raw of ["frozen-deadlock", "8012abc", ".8012", "8012."]) {
			expect(rawKeyIssue(raw)).toBeNull();
		}
	});

	it("resolves a malformed key to no issue rather than throwing", () => {
		expect(rawKeyIssue("")).toBeNull();
		expect(rawKeyIssue("chore:Park Sweep")).toBeNull();
	});

	it("names no issue for a zero key, which is not a board number", () => {
		expect(rawKeyIssue("0")).toBeNull();
		expect(rawKeyIssue("0.frozen-deadlock-1788645453")).toBeNull();
	});
});

describe("which of the two ways a key names no issue", () => {
	it("resolves a numbered key to the issue itself", () => {
		expect(resolveKeyIssue(key("8012"))).toEqual({_tag: "Issue", number: 8012});
		expect(resolveKeyIssue(key("8012.frozen-deadlock-20260905T194736"))).toEqual({
			_tag: "Issue",
			number: 8012,
		});
	});

	it("separates a chore lane, which names none by construction, from one that names none by accident", () => {
		expect(resolveKeyIssue(key("chore:park-sweep"))).toEqual({_tag: "Chore"});
		expect(resolveKeyIssue(key("frozen-deadlock"))).toEqual({_tag: "Unnumbered"});
		expect(resolveKeyIssue(key("8012abc"))).toEqual({_tag: "Unnumbered"});
	});
});

/**
 * One board issue, three spellings — the split this key reader exists to close. `05673` and `5673`
 * named different directories and only one of them carried a claim target, so a driver could hold
 * the claimable identity while another drove the padded one.
 */
describe("a padded issue number is one identity, not several", () => {
	const SPELLINGS = ["5673", "05673", "0005673"];

	it("gives every spelling the same canonical directory leaf under either root", () => {
		for (const raw of SPELLINGS) {
			expect(laneRef(key(raw), null)).toEqual({root: DEFAULT_LANES_ROOT, lane: "5673"});
			expect(laneRef(key(raw), "/tmp/lanes")).toEqual({root: "/tmp/lanes", lane: "5673"});
		}
	});

	it("addresses the same board issue and the same claim target from every spelling", () => {
		for (const raw of SPELLINGS) {
			expect(keyIssue(key(raw))).toBe(5673);
			expect(claimTarget(key(raw))).toEqual({_tag: "Number", number: 5673});
		}
	});

	it("agrees across every padding the reader accepts, not just the three above", () => {
		for (let zeros = 0; zeros <= 6; zeros += 1) {
			const spelled = key(`${"0".repeat(zeros)}5673`);

			expect(laneRef(spelled, null).lane).toBe("5673");
			expect(keyIssue(spelled)).toBe(5673);
			expect(claimTarget(spelled)).toEqual({_tag: "Number", number: 5673});
		}
	});

	it("trims only the leading number, leaving a quarantine suffix byte-identical", () => {
		expect(laneRef(key("05673.frozen-deadlock-20260905T194736"), null).lane).toBe(
			"5673.frozen-deadlock-20260905T194736",
		);
		expect(keyIssue(key("05673.frozen-deadlock-20260905T194736"))).toBe(5673);
	});

	it("canonicalizes a directory name a sweep read off a root the same way", () => {
		expect(resolveRawIssue("05673")).toEqual({_tag: "Issue", number: 5673});
		expect(rawKeyIssue("0005673")).toBe(5673);
		expect(resolveRawIssue("../chores/park-sweep")).toEqual({_tag: "Unnumbered"});
	});
});

describe("an issue key is one directory leaf", () => {
	it("refuses a separator or a traversal before any path is joined", () => {
		for (const raw of ["../chores/park-sweep", "a/b", "..", ".", "./5673", "5673/", "\\etc"]) {
			expect(parseKey(raw)._tag).toBe("Malformed");
		}
		expect(reasonFor("../chores/park-sweep")).toContain("directory leaf");
	});

	it("keeps chore addressing and the chore refusals it already had", () => {
		expect(key("chore:park-sweep")).toEqual({_tag: "Chore", name: "park-sweep"});
		expect(parseKey("chore:../../etc")._tag).toBe("Malformed");
		expect(reasonFor("chore:Park-Sweep")).toContain("lowercase kebab");
	});

	it("keeps a safe non-board key local rather than promoting it to a board issue", () => {
		for (const raw of ["epic-5492", "0", "frozen-deadlock"]) {
			expect(laneRef(key(raw), null).lane).toBe(raw);
			expect(keyIssue(key(raw))).toBeNull();
			expect(claimTarget(key(raw))._tag).toBe("Inert");
		}
	});
});
