import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as build from "./build/codes.ts";
import * as epic from "./epic/codes.ts";
import {
	ALIGNED_GROUPS,
	ALIGNMENT_BASE,
	type CodeTable,
	checkAlignment,
	codeTableGroupsIn,
	UNALIGNED_GROUPS,
} from "./exit-code-alignment.ts";
import * as hook from "./hook/codes.ts";
import * as plan from "./plan/codes.ts";
import * as report from "./report/codes.ts";
import * as review from "./review/codes.ts";
import * as reviewUi from "./review-ui/codes.ts";
import * as ship from "./ship/codes.ts";
import * as triage from "./triage/codes.ts";
import * as ui from "./ui/codes.ts";
import * as wire from "./wire/codes.ts";

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * The registry above names groups; this names the modules. Keeping the two apart is the point: the
 * coverage test below compares this hand-written set against what is on disk, so a group whose table
 * nobody registered reds here instead of shipping unchecked.
 */
const TABLES: Readonly<Record<string, CodeTable>> = {
	build,
	epic,
	hook,
	plan,
	report,
	review,
	"review-ui": reviewUi,
	ship,
	triage,
	ui,
	wire,
};

describe("every `<group>/codes.ts` in this package is accounted for", () => {
	const onDisk = codeTableGroupsIn(SRC_DIR);

	it("finds tables at all — a scan over nothing is a failure, not a pass (ADR 0092)", () => {
		expect(onDisk.length).toBeGreaterThan(0);
	});

	it("classifies each one as the base, aligned, or deliberately unaligned", () => {
		const registered = new Set([
			ALIGNMENT_BASE,
			...Object.keys(ALIGNED_GROUPS),
			...Object.keys(UNALIGNED_GROUPS),
		]);
		expect([...onDisk].sort()).toEqual([...registered].sort());
	});

	it("holds a module for each, so no registered group is checked against nothing", () => {
		expect(Object.keys(TABLES).sort()).toEqual([...onDisk].sort());
	});
});

describe.each(Object.entries(ALIGNED_GROUPS))("`%s` against `report`", (group, seats) => {
	const table = TABLES[group];

	it("has a module to check", () => {
		expect(table).toBeDefined();
	});

	it("seats every shared meaning on the base's number", () => {
		expect(checkAlignment(report, table as CodeTable, seats).drifted).toEqual([]);
	});

	it("adds no code the base already spoke for", () => {
		expect(checkAlignment(report, table as CodeTable, seats).collisions).toEqual([]);
	});
});

/**
 * `wire` is the control: it is registered as unaligned, and it would fail the alignment check it is
 * exempt from. Without this, "unaligned" could quietly come to mean "aligned anyway" and the
 * exemption would stop carrying information.
 */
describe("the unaligned groups are genuinely unaligned", () => {
	it("`wire` does not share the base's seats", () => {
		const {drifted} = checkAlignment(report, wire, ALIGNED_GROUPS.triage ?? {});
		expect(drifted.length).toBeGreaterThan(0);
	});
});
