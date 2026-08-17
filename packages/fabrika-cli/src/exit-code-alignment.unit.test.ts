import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import * as adr from "./adr/codes.ts";
import * as build from "./build/codes.ts";
import * as epic from "./epic/codes.ts";
import {
	ALIGNED_GROUPS,
	ALIGNMENT_BASE,
	allocatedCodes,
	type CodeTable,
	checkAlignment,
	codeTableGroupsIn,
	coverageGaps,
	UNALIGNED_GROUPS,
	UNTABLED_GROUPS,
	verbSeatedExitCodes,
	ZeroCoverageScope,
} from "./exit-code-alignment.ts";
import * as glossary from "./glossary/codes.ts";
import * as governance from "./governance/codes.ts";
import * as graduate from "./graduate/codes.ts";
import * as grill from "./grill/codes.ts";
import * as handoff from "./handoff/codes.ts";
import * as healCi from "./heal-ci/codes.ts";
import * as hook from "./hook/codes.ts";
import {PRETOOLUSE_BLOCKING_EXIT} from "./hook/harness-exit.ts";
import * as lane from "./lane/codes.ts";
import * as ledger from "./ledger/codes.ts";
import * as map from "./map/codes.ts";
import * as pattern from "./pattern/codes.ts";
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
	glossary,
	governance,
	graduate,
	grill,
	handoff,
	"heal-ci": healCi,
	hook,
	lane,
	ledger,
	map,
	pattern,
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
 * `2` is a seat no group may take, and this is where that is enforced across all of them.
 *
 * It is not a style rule. On `PreToolUse` exit `2` is the harness's one blocking code
 * (`./hook/harness-exit.ts`), so a table that seats any meaning on it denies a tool call as a side
 * effect of its exit status — which is how a fabrika that could not bootstrap came to block every
 * spawn in a session (#5423, ADR 0250). A per-group docblock cannot hold this: the property is that
 * NO group seats it, and only a scan over every shipped table can say so.
 */
describe("no group's exit table seats the harness's blocking code", () => {
	it("scans every table there is — an empty scan is a failure, not a pass (ADR 0092)", () => {
		expect(Object.keys(TABLES).length).toBeGreaterThan(0);
	});

	it.each(Object.entries(TABLES))("%s allocates nothing on it", (_name, table) => {
		expect(allocatedCodes(table).get(PRETOOLUSE_BLOCKING_EXIT)).toBeUndefined();
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

/**
 * The per-verb seat, pinned (#5296). `checkAlignment` reads a table's module namespace, so a code a
 * verb file declares for itself is invisible to it — which is how the base group came to seat two
 * meanings on `3` and two on `4` inside its own table.
 */
describe("no verb file seats an exit code its group's table does not", () => {
	const onDisk = codeTableGroupsIn(SRC_DIR);

	/** A throwaway source root: `<group>/codes.ts` plus whatever verb files a case needs. */
	const stub = (verbs: Readonly<Record<string, string>>): string => {
		const root = mkdtempSync(join(tmpdir(), "verb-seat-"));
		mkdirSync(join(root, "ghost"));
		writeFileSync(join(root, "ghost", "codes.ts"), "export const ZERO_SCOPE = 7;\n");
		for (const [name, source] of Object.entries(verbs))
			writeFileSync(join(root, "ghost", name), source);
		return root;
	};

	it("reads verb files at all — a scan over nothing is a failure, not a pass (ADR 0092)", () => {
		expect(verbSeatedExitCodes(SRC_DIR, onDisk).scanned).toBeGreaterThan(0);
	});

	it("finds none in any group that ships a table", () => {
		expect(verbSeatedExitCodes(SRC_DIR, onDisk).seated).toEqual([]);
	});

	it("reds on a constant a verb file declares and refuses with", () => {
		const root = stub({
			"thing-verb.ts": "export const QUEUE_UNREADABLE = 3;\nrefuse(QUEUE_UNREADABLE, 'nope');\n",
		});
		expect(verbSeatedExitCodes(root, ["ghost"]).seated).toEqual([
			"ghost/thing-verb.ts: QUEUE_UNREADABLE",
		]);
	});

	it("reds on a bare number handed straight to `refuse`", () => {
		const root = stub({"thing-verb.ts": "refuse(12, 'nope');\n"});
		expect(verbSeatedExitCodes(root, ["ghost"]).seated).toEqual(["ghost/thing-verb.ts: 12"]);
	});

	it("passes a numeric constant the file never refuses with — a round count is not a seat", () => {
		const root = stub({
			"thing-verb.ts":
				"const ROUND_LIMIT = 3;\nif (round >= ROUND_LIMIT) refuse(ZERO_SCOPE, 'x');\n",
		});
		expect(verbSeatedExitCodes(root, ["ghost"]).seated).toEqual([]);
	});

	it("throws rather than reporting none when there is nothing to scan (ADR 0092)", () => {
		expect(() => verbSeatedExitCodes(SRC_DIR, [])).toThrow(ZeroCoverageScope);
		expect(() => verbSeatedExitCodes(stub({}), ["ghost"])).toThrow(ZeroCoverageScope);
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
