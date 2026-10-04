/**
 * The boundary this module keeps: the bounds are pure and model-blind, so they reach `effect`, a
 * socket, another agent implementation and every other `src/ai-agent/` directory but `ports/` in
 * exactly zero places — tests included, which is why the item builders live in the fixtures
 * directory outside this one.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const sources = () =>
	readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({name, text: readFileSync(join(import.meta.dirname, name), "utf8")}));

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

describe("the history bounds are pure", () => {
	it("imports no runtime and no transport", () => {
		const banned = /^(effect|@effect\/|ws$|node:net|node:dgram|node:http)/;
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((specifier) => banned.test(specifier))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("reaches no agent implementation and no sibling agent directory but ports", () => {
		const offenders = sources().flatMap(({name, text}) =>
			importsOf(text)
				.filter((specifier) => specifier.startsWith("."))
				.filter((specifier) => !specifier.startsWith("./"))
				.filter((specifier) => !specifier.startsWith("../ports/"))
				.filter((specifier) => !specifier.startsWith("../../ai-agent-fixtures/"))
				.map((specifier) => `${name}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it("names no model, session, provider or SDK field of its own", () => {
		const banned = /\b(model|modelName|provider|cost|tokens|sessionId|sdk)\b/i;
		const offenders = sources()
			.filter(({name}) => !name.endsWith(".unit.test.ts"))
			.flatMap(({name, text}) =>
				text
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/(^|[^:])\/\/.*$/gm, "$1")
					.split("\n")
					.filter((line) => banned.test(line))
					.map((line) => `${name}: ${line.trim()}`),
			);
		expect(offenders).toEqual([]);
	});
});
