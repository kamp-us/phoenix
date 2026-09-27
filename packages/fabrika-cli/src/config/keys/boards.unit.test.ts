import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {BOARDS, boardsKey, SHIPPED_ON_CALL} from "./boards.ts";

const declared = (boards: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[BOARDS]: boards})}), boardsKey);

describe("a repo with no `boards` block", () => {
	it("has one board", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), boardsKey)).toMatchObject({
			_tag: "Default",
			value: {_tag: "One"},
		});
		expect(
			resolve(loadConfig({_tag: "Text", text: JSON.stringify({table: {}})}), boardsKey),
		).toMatchObject({_tag: "Default", value: {_tag: "One"}});
	});
});

describe("a declared on-call board", () => {
	it("splits on the shipped values when it declares nothing else", () => {
		expect(declared({onCall: {}})).toEqual({
			_tag: "Declared",
			value: {_tag: "Split", onCall: SHIPPED_ON_CALL},
		});
		expect(SHIPPED_ON_CALL).toEqual({
			route: {origins: ["customer"], types: ["bug"], labels: []},
			responseTargets: {
				byLabel: [{name: "same day", hours: 24, labels: ["p0"]}],
				otherwise: {name: "this week", hours: 168},
			},
			spendShare: 20,
			project: {owner: null, number: null},
		});
	});

	it("takes each sub-key the repo wrote and the shipped value for the rest", () => {
		expect(
			declared({
				onCall: {
					route: {labels: ["ci-broken"]},
					responseTargets: {
						byLabel: [{name: "now", hours: 2, labels: ["outage"]}],
						otherwise: {name: "soon", hours: 48},
					},
					spendShare: 35,
					project: {number: 9},
				},
			}),
		).toEqual({
			_tag: "Declared",
			value: {
				_tag: "Split",
				onCall: {
					route: {origins: ["customer"], types: ["bug"], labels: ["ci-broken"]},
					responseTargets: {
						byLabel: [{name: "now", hours: 2, labels: ["outage"]}],
						otherwise: {name: "soon", hours: 48},
					},
					spendShare: 35,
					project: {owner: null, number: 9},
				},
			},
		});
	});

	it.each([
		["a block with no onCall board", {}],
		["a stray top-level key", {onCall: {}, product: {}}],
		["a stray on-call key", {onCall: {size: "S"}}],
		["a route list that is not a list", {onCall: {route: {types: "bug"}}}],
		["a route naming one label twice", {onCall: {route: {labels: ["a", "a"]}}}],
		["a zero-hour target", {onCall: {responseTargets: {otherwise: {name: "never", hours: 0}}}}],
		[
			"a labeled target naming no label",
			{onCall: {responseTargets: {byLabel: [{name: "x", hours: 1, labels: []}]}}},
		],
		[
			"one target name used twice",
			{
				onCall: {
					responseTargets: {
						byLabel: [{name: "soon", hours: 1, labels: ["a"]}],
						otherwise: {name: "soon", hours: 5},
					},
				},
			},
		],
		["a share over 100", {onCall: {spendShare: 120}}],
		["a share of zero", {onCall: {spendShare: 0}}],
		["a project number that is not a positive integer", {onCall: {project: {number: 0}}}],
	])("refuses %s whole", (_name, value) => {
		expect(declared(value)).toMatchObject({_tag: "Malformed"});
	});

	it("names no path, repository, issue number or login in its shipped values", () => {
		expect(SHIPPED_ON_CALL.project).toEqual({owner: null, number: null});
		const strings: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === "string") strings.push(value);
			else if (Array.isArray(value)) value.forEach(walk);
			else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
		};
		walk(SHIPPED_ON_CALL);
		for (const text of strings) expect(text).not.toMatch(/[/#@]/);
	});
});

describe("the schema `config schema` emits", () => {
	it("documents the block and each of its keys", () => {
		const schema = boardsKey.jsonSchema;
		expect(schema?.description).toBeTruthy();
		const onCall = schema?.properties?.onCall;
		expect(onCall?.description).toBeTruthy();
		expect(Object.keys(onCall?.properties ?? {}).sort()).toEqual(
			Object.keys(SHIPPED_ON_CALL).sort(),
		);
		const leaves = (node: typeof schema, path: string): Array<[string, string | undefined]> =>
			Object.entries(node?.properties ?? {}).flatMap(([key, child]) => [
				[`${path}.${key}`, child.description] as [string, string | undefined],
				...leaves(child, `${path}.${key}`),
				...leaves(child.items, `${path}.${key}[]`),
			]);
		for (const [path, description] of leaves(schema, BOARDS)) {
			expect(description, path).toBeTruthy();
		}
	});
});
