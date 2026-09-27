import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {OUTSIDE_THE_BETS, SHIPPED_TABLE, TABLE, tableKey} from "./table.ts";

const declared = (table: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[TABLE]: table})}), tableKey);

describe("the shipped table", () => {
	it("is every threshold the rulings name, for a repo with no config", () => {
		const resolved = resolve(loadConfig({_tag: "Absent"}), tableKey);

		expect(resolved).toMatchObject({_tag: "Default"});
		expect(SHIPPED_TABLE).toEqual({
			cadence: "weekly",
			day: "monday",
			sections: ["Tails", "Customers", "New bets", "Outside the bets"],
			agendaCap: 25,
			sizes: {S: 15, M: 35, L: 40},
			stopMultiple: 2,
			asksFlag: 3,
			stuckDays: 3,
			activeCampaignFlag: 3,
			fabrikaShare: {percent: 40, forTables: 4, thenPercent: 30},
			checkDelayDays: 14,
			project: {owner: null, number: null},
		});
	});

	it("names no path, repository, issue number or login", () => {
		const strings: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === "string") strings.push(value);
			else if (Array.isArray(value)) value.forEach(walk);
			else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
		};
		walk(SHIPPED_TABLE);

		for (const text of strings) expect(text).not.toMatch(/[/#@\d]/);
		expect(SHIPPED_TABLE.project).toEqual({owner: null, number: null});
	});

	it("documents every sub-key in the schema `config schema` emits", () => {
		const properties = tableKey.jsonSchema?.properties ?? {};

		expect(Object.keys(properties).sort()).toEqual(Object.keys(SHIPPED_TABLE).sort());
		for (const [key, schema] of Object.entries(properties)) {
			expect(schema.description, key).toBeTruthy();
		}
	});
});

describe("a declared table block", () => {
	it("keeps the shipped value for every sub-key it leaves out", () => {
		const resolved = declared({agendaCap: 10, sizes: {S: 20}});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.agendaCap).toBe(10);
		expect(resolved.value.sizes).toEqual({S: 20, M: 35, L: 40});
		expect(resolved.value.stuckDays).toBe(SHIPPED_TABLE.stuckDays);
	});

	it("takes a project target", () => {
		const resolved = declared({project: {owner: "acme", number: 4}});

		expect(resolved).toMatchObject({
			_tag: "Declared",
			value: {project: {owner: "acme", number: 4}},
		});
	});

	it.each([
		[{cadence: "daily"}, "`table.cadence`"],
		[{day: "someday"}, "`table.day`"],
		[{agendaCap: 0}, "`table.agendaCap`"],
		[{stopMultiple: 1}, "`table.stopMultiple`"],
		[{sizes: {XL: 90}}, "`table.sizes.XL`"],
		[{fabrikaShare: {percent: 140}}, "`table.fabrikaShare.percent`"],
		[{project: {number: -1}}, "`table.project.number`"],
		[{project: {owner: "not a login"}}, "`table.project.owner`"],
		[{sections: []}, "`table.sections`"],
		[{sections: ["Tails", "Tails", OUTSIDE_THE_BETS]}, "twice"],
		[{sections: ["Tails", "New bets"]}, OUTSIDE_THE_BETS],
		[{unknown: 1}, "`table.unknown`"],
		["weekly", "`table` is not an object"],
	])("refuses %j whole, naming %s", (table, named) => {
		const resolved = declared(table);

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(named);
	});
});
