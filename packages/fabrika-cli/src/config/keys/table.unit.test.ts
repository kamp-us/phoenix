import {describe, expect, it} from "vitest";
import type {JsonSchema} from "../json-schema.ts";
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
			flagMultiple: 1,
			stopMultiple: 2,
			asksFlag: 3,
			stuckDays: 3,
			activeCampaignFlag: 3,
			fabrikaShare: {percent: 40, forTables: 4, thenPercent: 30, labels: []},
			checkDelayDays: 14,
			evidenceSources: [],
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

describe("the schema's numeric bounds", () => {
	/** Every numeric leaf of the schema, as its path and its schema. */
	const leaves = (schema: JsonSchema, path: ReadonlyArray<string>): Array<[string[], JsonSchema]> =>
		Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
			child.properties !== undefined
				? leaves(child, [...path, key])
				: child.minimum !== undefined || child.exclusiveMinimum !== undefined
					? [[[...path, key], child] as [string[], JsonSchema]]
					: [],
		);
	const at = (path: ReadonlyArray<string>, value: number): unknown =>
		path.reduceRight<unknown>((inner, key) => ({[key]: inner}), value);
	const cases = leaves(tableKey.jsonSchema ?? {}, []);

	it("covers the percentages and the stop multiple", () => {
		expect(cases.map(([path]) => path.join("."))).toEqual(
			expect.arrayContaining(["stopMultiple", "fabrikaShare.percent", "fabrikaShare.thenPercent"]),
		);
	});

	it.each(cases)("%j: the decoder refuses exactly what the schema excludes", (path, schema) => {
		const step = [schema.type].flat().includes("integer") ? 1 : 0.5;
		const floor = schema.exclusiveMinimum ?? schema.minimum ?? 0;
		const lowestAccepted = schema.exclusiveMinimum !== undefined ? floor + step : floor;
		const highestRefused = schema.exclusiveMinimum !== undefined ? floor : floor - step;

		expect(declared(at(path, lowestAccepted))._tag).toBe("Declared");
		expect(declared(at(path, highestRefused))._tag).toBe("Malformed");
	});
});

describe("a declared table block", () => {
	it("keeps the shipped value for every sub-key it leaves out", () => {
		const resolved = declared({agendaCap: 10, fabrikaShare: {percent: 50}});

		expect(resolved._tag).toBe("Declared");
		if (resolved._tag !== "Declared") return;
		expect(resolved.value.agendaCap).toBe(10);
		expect(resolved.value.fabrikaShare).toEqual({
			percent: 50,
			forTables: 4,
			thenPercent: 30,
			labels: [],
		});
		expect(resolved.value.stuckDays).toBe(SHIPPED_TABLE.stuckDays);
	});

	it("takes the labels that mark fabrika's own work", () => {
		const resolved = declared({fabrikaShare: {labels: [" pipeline ", "fabrika"]}});

		expect(resolved).toMatchObject({
			_tag: "Declared",
			value: {fabrikaShare: {percent: 40, labels: ["pipeline", "fabrika"]}},
		});
	});

	it("takes evidence sources, each timeout defaulting when left out", () => {
		const resolved = declared({
			checkDelayDays: 7,
			evidenceSources: [
				{name: " metrics ", command: ["pnpm", "metrics"]},
				{name: "errors", command: ["./errors.sh"], timeoutSeconds: 5},
			],
		});

		expect(resolved).toMatchObject({
			_tag: "Declared",
			value: {
				checkDelayDays: 7,
				evidenceSources: [
					{name: "metrics", command: ["pnpm", "metrics"], timeoutSeconds: 60},
					{name: "errors", command: ["./errors.sh"], timeoutSeconds: 5},
				],
			},
		});
	});

	it("takes a flag point below the stop, and sections reordered or added to", () => {
		const resolved = declared({
			flagMultiple: 1.5,
			stopMultiple: 3,
			sections: ["Customers", "Tails", "Chores", "New bets", OUTSIDE_THE_BETS],
		});

		expect(resolved).toMatchObject({
			_tag: "Declared",
			value: {
				flagMultiple: 1.5,
				stopMultiple: 3,
				sections: ["Customers", "Tails", "Chores", "New bets", OUTSIDE_THE_BETS],
			},
		});
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
		[{sizes: {S: 50}}, "`table.sizes`"],
		[{fabrikaShare: {share: 90}}, "`table.fabrikaShare.share`"],
		[{fabrikaShare: {percent: 140}}, "`table.fabrikaShare.percent`"],
		[{fabrikaShare: {labels: "fabrika"}}, "`table.fabrikaShare.labels`"],
		[{fabrikaShare: {labels: ["fabrika", "fabrika"]}}, "twice"],
		[{project: {number: -1}}, "`table.project.number`"],
		[{project: {owner: "not a login"}}, "`table.project.owner`"],
		[{sections: []}, "`table.sections`"],
		[{sections: ["Tails", "Tails", OUTSIDE_THE_BETS]}, "twice"],
		[{sections: ["Tails", "New bets"]}, OUTSIDE_THE_BETS],
		[{sections: ["Tails", "Customers", OUTSIDE_THE_BETS]}, '"New bets"'],
		[{sections: ["Bugs", "Features", OUTSIDE_THE_BETS]}, '"Tails", "Customers", "New bets"'],
		[{flagMultiple: 0.5}, "`table.flagMultiple`"],
		[{flagMultiple: 2}, "`table.flagMultiple` (2) is not below `table.stopMultiple` (2)"],
		[{flagMultiple: 2.5, stopMultiple: 2.5}, "is not below"],
		[{checkDelayDays: 0}, "`table.checkDelayDays`"],
		[{evidenceSources: {name: "x"}}, "`table.evidenceSources`"],
		[{evidenceSources: [{name: "x", command: []}]}, "`table.evidenceSources[0].command`"],
		[{evidenceSources: [{name: "", command: ["x"]}]}, "`table.evidenceSources[0].name`"],
		[
			{evidenceSources: [{name: "x", command: ["x"], timeoutSeconds: 601}]},
			"`table.evidenceSources[0].timeoutSeconds`",
		],
		[
			{evidenceSources: [{name: "x", command: ["x"], shell: true}]},
			"`table.evidenceSources[0].shell`",
		],
		[
			{
				evidenceSources: [
					{name: "x", command: ["a"]},
					{name: "x", command: ["b"]},
				],
			},
			"twice",
		],
		[{unknown: 1}, "`table.unknown`"],
		["weekly", "`table` is not an object"],
	])("refuses %j whole, naming %s", (table, named) => {
		const resolved = declared(table);

		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain(named);
	});
});
