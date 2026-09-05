/**
 * The boundary this directory keeps: the mapping is pure, and the Agent SDK reaches it as types
 * only. A runtime SDK import here would put the CLI's spawn on the path of a function the layer
 * calls per message, and an Effect import would make the one testable-without-a-runtime piece of
 * the Claude program need a runtime to test.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const sources = () =>
	readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({name, text: readFileSync(join(import.meta.dirname, name), "utf8")}));

const shipped = () => sources().filter(({name}) => !name.endsWith(".unit.test.ts"));

const importsOf = (text: string) =>
	[...text.matchAll(/(^|\n)import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/g)].map((match) => ({
		specifier: match[3] ?? "",
		typeOnly: match[2] !== undefined,
	}));

describe("the Claude history mapping is pure", () => {
	it("imports no Effect and no transport", () => {
		const banned = /^(effect$|effect\/|@effect\/|ws$|node:net|node:http|node:child_process)/;
		const offenders = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.filter((one) => banned.test(one.specifier))
				.map((one) => `${name}: ${one.specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("imports the Agent SDK as types only", () => {
		const sdk = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.filter((one) => one.specifier.startsWith("@anthropic-ai/"))
				.map((one) => ({name, ...one})),
		);
		expect(sdk.length).toBeGreaterThan(0);
		expect(sdk.filter((one) => !one.typeOnly)).toEqual([]);
	});

	it("reaches no other Claude slice and no agent directory but ports and history", () => {
		const allowed = [/^\.\//, /^\.\.\/\.\.\/ai-agent\/(ports|history|events)/];
		const offenders = shipped().flatMap(({name, text}) =>
			importsOf(text)
				.map((one) => one.specifier)
				.filter((specifier) => specifier.startsWith("."))
				.filter((specifier) => !allowed.some((pattern) => pattern.test(specifier)))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("keeps every fixture the tests name, so none can be quietly dropped", () => {
		const fixtures = readdirSync(join(import.meta.dirname, "fixtures"))
			.filter((name) => name.endsWith(".json"))
			.map((name) => name.replace(/\.json$/, ""))
			.sort();
		expect(fixtures).toEqual([
			"assistant-turn",
			"error-result",
			"init",
			"interrupted-assistant",
			"oversized-tool-turn",
			"permission-denied",
			"resumed-init",
			"session-messages",
			"tool-turn",
			"unknown-message",
		]);
	});

	it("carries no operator path in a fixture", () => {
		const dir = join(import.meta.dirname, "fixtures");
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.filter((name) => /\/Users\/|\/var\/folders\//.test(readFileSync(join(dir, name), "utf8")));
		expect(offenders).toEqual([]);
	});
});
