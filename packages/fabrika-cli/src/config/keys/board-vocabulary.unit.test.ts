import {describe, expect, it} from "vitest";
import {STATUSES} from "../../labels.ts";
import {
	AUDIENCES,
	DEFAULT_BOARD_VOCABULARY,
	FACET_VOCABULARY,
	PRIORITIES,
	STANDING_LANES,
	TYPES,
} from "../../triage/facets.ts";
import {statusList} from "../board.ts";
import {loadConfig, resolve} from "../load.ts";
import {resolveBoard} from "../resolve-board.ts";
import {BOARD_VOCABULARY, boardVocabularyKey} from "./board-vocabulary.ts";
import {TRIAGE_FACETS} from "./triage-facets.ts";

const load = (config: unknown) =>
	loadConfig({_tag: "Text", text: JSON.stringify({[BOARD_VOCABULARY]: config})});

const declared = (config: unknown) => resolve(load(config), boardVocabularyKey);

const board = (config: Record<string, unknown>) =>
	resolveBoard(loadConfig({_tag: "Text", text: JSON.stringify(config)}), FACET_VOCABULARY);

const owns = (
	read: ReturnType<typeof resolveBoard>,
	name: string,
): {readonly _tag: string} | undefined =>
	read._tag === "Resolved" ? read.resolved.facets.find((f) => f.name === name)?.owns : undefined;

describe("the shipped default is phoenix's board", () => {
	it("resolves every list to today's value for a repo with no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), boardVocabularyKey);
		expect(resolved._tag).toBe("Default");
		if (resolved._tag !== "Default") return;
		expect(resolved.value.types).toEqual(TYPES);
		expect(resolved.value.priorities).toEqual(PRIORITIES);
		expect(resolved.value.audiences).toEqual(AUDIENCES);
		expect(resolved.value.standingLanes).toEqual(STANDING_LANES);
		expect(statusList(resolved.value.statuses)).toEqual(STATUSES);
	});

	it("composes to the facet table `triageFacets` ships, patterns and all", () => {
		const read = board({});
		expect(read._tag).toBe("Resolved");
		if (read._tag !== "Resolved") return;
		expect(read.resolved.facets).toEqual(FACET_VOCABULARY);
		expect(read.resolved.board).toEqual(DEFAULT_BOARD_VOCABULARY);
	});
});

describe("a declared vocabulary", () => {
	it("takes only what it names, leaving the other four at their defaults", () => {
		const resolved = declared({types: ["task", "epic"]});
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.types).toEqual(["task", "epic"]);
		expect(resolved.value.priorities).toEqual(PRIORITIES);
		expect(statusList(resolved.value.statuses)).toEqual(STATUSES);
	});

	it("renames one status role and leaves the other four", () => {
		const resolved = declared({statuses: {triaged: "state:ready"}});
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.statuses.triaged).toBe("state:ready");
		expect(resolved.value.statuses.needsInfo).toBe("status:needs-info");
	});

	it("refuses an empty list — a facet with no vocabulary accepts nothing", () => {
		const resolved = declared({priorities: []});
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("priorities");
	});

	/** Zero lanes disables no gate — it says every issue homes on a milestone (#6440). */
	it("takes an empty standingLanes as a declaration, not as a disabled facet", () => {
		const resolved = declared({standingLanes: []});
		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.standingLanes).toEqual([]);
		expect(resolved.value.priorities).toEqual(PRIORITIES);
	});

	it("refuses a sub-key nobody reads, rather than ignoring it", () => {
		const resolved = declared({standingLane: ["team:infra"]});
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("standingLane");
	});

	it("refuses a status role nobody reads", () => {
		expect(declared({statuses: {shipped: "status:shipped"}})._tag).toBe("Malformed");
	});

	it("refuses one label given to two roles — the reconcile could not say which it wrote", () => {
		expect(declared({statuses: {triaged: "status:needs-info"}})._tag).toBe("Malformed");
	});

	it("refuses a duplicate entry and a non-string entry alike", () => {
		expect(declared({types: ["bug", "bug"]})._tag).toBe("Malformed");
		expect(declared({types: ["bug", 7]})._tag).toBe("Malformed");
		expect(declared({types: "bug"})._tag).toBe("Malformed");
	});
});

/**
 * The composition is what stops the two keys drifting into #4285's shape: a declared value its
 * facet has no authority to remove is written once and never superseded.
 */
describe("composing the board with the facet table", () => {
	it("keeps a shipped pattern that still contains the declared values", () => {
		const read = board({[BOARD_VOCABULARY]: {priorities: ["p0", "p1"]}});
		expect(owns(read, "priority")).toEqual({_tag: "Pattern", source: "^p\\d+$"});
	});

	it("falls to set ownership over exactly the declared values when the pattern does not own them", () => {
		const read = board({[BOARD_VOCABULARY]: {priorities: ["sev1", "sev2"]}});
		expect(owns(read, "priority")).toEqual({_tag: "Set", labels: ["sev1", "sev2"]});
	});

	it("gives a declared lane set delete authority over itself, never over the shipped lanes", () => {
		const read = board({[BOARD_VOCABULARY]: {standingLanes: ["team:infra"]}});
		expect(owns(read, "lane")).toEqual({_tag: "Set", labels: ["team:infra"]});
	});

	it("takes ownership from `triageFacets` where a repo declared it", () => {
		const read = board({
			[BOARD_VOCABULARY]: {priorities: ["sev1"]},
			[TRIAGE_FACETS]: [
				{name: "priority", owns: "^sev\\d+$", values: ["sev1"]},
				{name: "type", owns: "^type:", values: TYPES.map((t) => `type:${t}`)},
				{name: "status", owns: "^status:", values: [...STATUSES]},
				{name: "audience", owns: "^ready-for:", values: AUDIENCES.map((a) => `ready-for:${a}`)},
				{name: "lane", ownsLabels: [...STANDING_LANES], values: [...STANDING_LANES]},
			],
		});
		expect(owns(read, "priority")).toEqual({_tag: "Pattern", source: "^sev\\d+$"});
	});

	it("refuses a declared ownership that does not contain the board's own values", () => {
		const read = board({
			[BOARD_VOCABULARY]: {priorities: ["sev1"]},
			[TRIAGE_FACETS]: [{name: "priority", owns: "^p\\d+$", values: ["p0"]}],
		});
		expect(read._tag).toBe("Refused");
		if (read._tag !== "Refused") return;
		expect(read.reason).toContain("sev1");
	});

	it("refuses a declared facet the reconcile has no seat for", () => {
		const read = board({
			[TRIAGE_FACETS]: [{name: "severity", ownsLabels: ["sev1"], values: ["sev1"]}],
		});
		expect(read._tag).toBe("Refused");
		if (read._tag !== "Refused") return;
		expect(read.reason).toContain("severity");
	});

	it("refuses when either key could not be decoded, never falling to a default", () => {
		expect(board({[BOARD_VOCABULARY]: {types: []}})._tag).toBe("Refused");
		expect(
			resolveBoard(loadConfig({_tag: "Unreadable", reason: "EACCES"}), FACET_VOCABULARY)._tag,
		).toBe("Refused");
	});
});
