import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as adr from "./adr/codes.ts";
import * as build from "./build/codes.ts";
import * as epic from "./epic/codes.ts";
import * as evalCodes from "./eval/codes.ts";
import {
	ALIGNED_GROUPS,
	ALIGNMENT_BASE,
	type CodeTable,
	checkAlignment,
	codeTableGroupsIn,
	coverageGaps,
	UNALIGNED_GROUPS,
	UNTABLED_GROUPS,
	ZeroCoverageScope,
} from "./exit-code-alignment.ts";
import * as glossary from "./glossary/codes.ts";
import * as governance from "./governance/codes.ts";
import * as grill from "./grill/codes.ts";
import * as handoff from "./handoff/codes.ts";
import * as hook from "./hook/codes.ts";
import * as ledger from "./ledger/codes.ts";
import * as map from "./map/codes.ts";
import * as plan from "./plan/codes.ts";
import {registeredGroups} from "./registry.ts";
import * as report from "./report/codes.ts";
import * as review from "./review/codes.ts";
import * as reviewUi from "./review-ui/codes.ts";
import * as ship from "./ship/codes.ts";
import * as spend from "./spend/codes.ts";
import * as spike from "./spike/codes.ts";
import * as status from "./status/codes.ts";
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
	adr,
	build,
	epic,
	eval: evalCodes,
	glossary,
	governance,
	grill,
	handoff,
	hook,
	ledger,
	map,
	plan,
	report,
	review,
	"review-ui": reviewUi,
	ship,
	spend,
	spike,
	status,
	triage,
	ui,
	wire,
};

describe("every verb group the CLI ships is accounted for", () => {
	const shipped = registeredGroups.map((group) => group.name);
	const onDisk = codeTableGroupsIn(SRC_DIR);
	const gaps = () => coverageGaps({registered: shipped, onDisk});

	it("finds groups and tables at all — a scan over nothing is a failure, not a pass (ADR 0092)", () => {
		expect(shipped.length).toBeGreaterThan(0);
		expect(onDisk.length).toBeGreaterThan(0);
	});

	it("classifies each as the base, aligned, deliberately unaligned, or recorded untabled", () => {
		expect(gaps().unclassified).toEqual([]);
	});

	it("classifies nothing the CLI no longer ships", () => {
		expect(gaps().unshipped).toEqual([]);
	});

	it("keeps the untabled record true in both directions", () => {
		expect(gaps().untabledWithTable).toEqual([]);
		expect(gaps().tableMissing).toEqual([]);
	});

	it("holds a module for each table on disk, so no checked group is checked against nothing", () => {
		expect(Object.keys(TABLES).sort()).toEqual([...onDisk].sort());
	});
});

/**
 * The blindness itself, pinned (#5213). Scoping the scan to `codes.ts` files made a group that
 * ships none unreachable by the check — so it could sit in no registry and the suite stayed green.
 * These assert the property that removes it: scope comes from what is shipped, and an empty scan
 * is a throw rather than an all-clear.
 */
describe("the coverage scan can see a group that ships no table", () => {
	it("reports a shipped group with no table and no registration", () => {
		expect(
			coverageGaps({registered: [ALIGNMENT_BASE, "ghost"], onDisk: [ALIGNMENT_BASE]}),
		).toMatchObject({unclassified: ["ghost"]});
	});

	it("reports a table on disk that no registry classifies", () => {
		expect(
			coverageGaps({registered: [ALIGNMENT_BASE], onDisk: [ALIGNMENT_BASE, "ghost"]}),
		).toMatchObject({unclassified: ["ghost"]});
	});

	it("throws rather than reporting no gaps when there is nothing to scan (ADR 0092)", () => {
		expect(() => coverageGaps({registered: [], onDisk: [ALIGNMENT_BASE]})).toThrow(
			ZeroCoverageScope,
		);
		expect(() => coverageGaps({registered: [ALIGNMENT_BASE], onDisk: []})).toThrow(
			ZeroCoverageScope,
		);
	});
});

/**
 * The untabled record is an admission of a tracked gap, not a way to opt out of the guard: each
 * entry must name a reason, and none may be a group that already carries a table. It is empty today
 * (#5294) — the covered state, and the one state that needs no reason.
 */
describe("the untabled groups are genuinely untabled", () => {
	it("states a reason for each", () => {
		for (const reason of Object.values(UNTABLED_GROUPS)) expect(reason).not.toEqual("");
	});

	it("names no group that also appears in an alignment registry", () => {
		const aligned = new Set([
			ALIGNMENT_BASE,
			...Object.keys(ALIGNED_GROUPS),
			...Object.keys(UNALIGNED_GROUPS),
		]);
		expect(Object.keys(UNTABLED_GROUPS).filter((name) => aligned.has(name))).toEqual([]);
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
