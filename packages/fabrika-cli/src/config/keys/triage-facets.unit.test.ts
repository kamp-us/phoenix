import {describe, expect, it} from "vitest";
import {
	AUDIENCES,
	FACET_VOCABULARY,
	PRIORITIES,
	STANDING_LANES,
	TYPES,
} from "../../triage/facets.ts";
import {loadConfig, resolve} from "../load.ts";
import {TRIAGE_FACETS, triageFacetsKey} from "./triage-facets.ts";

const load = (config: unknown) =>
	loadConfig({_tag: "Text", text: JSON.stringify({[TRIAGE_FACETS]: config})});

/** The conforming table, as a config would write it. Every violating case below is one edit off it. */
const CONFORMING = [
	{name: "type", owns: "^type:", values: TYPES.map((type) => `type:${type}`)},
	{name: "priority", owns: "^p\\d+$", values: [...PRIORITIES]},
	{
		name: "status",
		ownsLabels: ["status:needs-triage", "status:triaged", "status:needs-info"],
		values: ["status:needs-triage", "status:triaged", "status:needs-info"],
	},
	{
		name: "audience",
		owns: "^ready-for:",
		values: AUDIENCES.map((audience) => `ready-for:${audience}`),
	},
	{name: "lane", ownsLabels: [...STANDING_LANES], values: [...STANDING_LANES]},
];

const edited = (name: string, over: Record<string, unknown>): ReadonlyArray<unknown> =>
	CONFORMING.map((facet) => (facet.name === name ? {...facet, ...over} : facet));

describe("the shipped default", () => {
	it("is phoenix's own vocabulary, and it conforms", () => {
		expect(triageFacetsKey.shippedDefault).toBe(FACET_VOCABULARY);
		expect(loadConfig({_tag: "Absent"})).toEqual({_tag: "Config", state: {_tag: "Absent"}});
	});

	it("resolves for a repo that declares no config at all", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), triageFacetsKey);
		expect(resolved._tag).toBe("Default");
	});
});

describe("a declared table", () => {
	it("resolves cleanly when it conforms", () => {
		const resolved = resolve(load(CONFORMING), triageFacetsKey);
		expect(resolved._tag).toBe("Declared");
	});

	it("refuses the whole load when a priority value its pattern does not own is declared", () => {
		const refused = load(edited("priority", {values: ["p0", "p1", "urgent"]}));
		expect(refused._tag).toBe("Refused");
		if (refused._tag !== "Refused") return;
		expect(refused.reason).toContain("facet `priority`");
		expect(refused.reason).toContain("urgent");
	});

	it("refuses when a type facet's pattern matches labels no declared type produces", () => {
		const refused = load(edited("type", {owns: "^kind:"}));
		expect(refused._tag).toBe("Refused");
		if (refused._tag !== "Refused") return;
		expect(refused.reason).toContain("facet `type`");
		expect(refused.reason).toContain("owns=/^kind:/");
	});

	it("refuses when the standing-lane set owns a label outside its values", () => {
		const refused = load(edited("lane", {ownsLabels: [...STANDING_LANES, "axis:dead"]}));
		expect(refused._tag).toBe("Refused");
		if (refused._tag !== "Refused") return;
		expect(refused.reason).toContain("facet `lane`");
		expect(refused.reason).toContain("axis:dead");
	});

	it("resolves every OTHER key as malformed once the load is refused", () => {
		const refused = load(edited("priority", {values: ["urgent"]}));
		expect(resolve(refused, triageFacetsKey)._tag).toBe("Malformed");
	});
});

describe("decoding", () => {
	const malformed = (config: unknown): string => {
		const resolved = resolve(load(config), triageFacetsKey);
		expect(resolved._tag).toBe("Malformed");
		return resolved._tag === "Malformed" ? resolved.reason : "";
	};

	it("refuses a non-array", () => {
		expect(malformed({name: "type"})).toContain("is not an array");
	});

	it("refuses an empty table, which would hand every facet zero delete authority", () => {
		expect(malformed([])).toContain("no facet would own anything");
	});

	it("refuses a facet with no name", () => {
		expect(malformed([{owns: "^type:", values: ["type:bug"]}])).toContain("declares no `name`");
	});

	it("refuses a facet with no values", () => {
		expect(malformed([{name: "type", owns: "^type:", values: []}])).toContain("`values`");
	});

	it("refuses a facet declaring neither ownership form", () => {
		expect(malformed([{name: "type", values: ["type:bug"]}])).toContain(
			"declares neither `owns` nor `ownsLabels`",
		);
	});

	it("refuses a facet declaring both ownership forms", () => {
		expect(
			malformed([{name: "type", owns: "^type:", ownsLabels: ["type:bug"], values: ["type:bug"]}]),
		).toContain("declares both");
	});

	it("refuses a pattern that is not a usable regular expression", () => {
		expect(malformed([{name: "type", owns: "^type:(", values: ["type:bug"]}])).toContain(
			"not a usable regular expression",
		);
	});

	it("refuses one facet declared twice", () => {
		expect(malformed([...CONFORMING, CONFORMING[1]])).toContain("twice");
	});
});
