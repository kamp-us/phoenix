import {describe, expect, it} from "vitest";
import {effectPin, judge, listedFiles, placement, render, resolvedFiles} from "./outside.ts";

const CHECKOUT = "/home/ci/phoenix";
const WORK = "/tmp/tuval-sdk-outside-abc";
const SDK = `${WORK}/example/node_modules/@kampus/tuval-sdk/dist/authoring/index.js`;

describe("where the example runs", () => {
	it("accepts a directory beside the checkout, even one sharing its name as a prefix", () => {
		expect(placement(CHECKOUT, WORK)).toEqual({_tag: "Outside"});
		expect(placement(CHECKOUT, "/home/ci/phoenix-tmp/x")).toEqual({_tag: "Outside"});
	});

	it("refuses a directory under the checkout, where resolution could walk up into it", () => {
		expect(placement(CHECKOUT, `${CHECKOUT}/tmp/x`)).toEqual({
			_tag: "Inside",
			path: `${CHECKOUT}/tmp/x`,
		});
		expect(placement(CHECKOUT, CHECKOUT)).toEqual({_tag: "Inside", path: CHECKOUT});
	});
});

describe("reading what each phase resolved", () => {
	it("takes every non-blank line of tsc --listFiles as a path", () => {
		expect(listedFiles(`${WORK}/example/src/counter.ts\n\n  ${SDK}  \n`)).toEqual([
			`${WORK}/example/src/counter.ts`,
			SDK,
		]);
	});

	it("keeps only file URLs from the resolve log, once each", () => {
		const log = ["node:fs", `file://${SDK}`, "data:text/javascript,1", `file://${SDK}`, ""].join(
			"\n",
		);
		expect(resolvedFiles(log)).toEqual([SDK]);
	});
});

describe("the effect pin", () => {
	it("reads the exact effect version off the packed manifest", () => {
		expect(effectPin(JSON.stringify({dependencies: {effect: "4.0.0-rc.112"}}))).toBe(
			"4.0.0-rc.112",
		);
	});

	it("refuses a manifest that pins no effect, or pins it through the workspace", () => {
		expect(() => effectPin(JSON.stringify({dependencies: {}}))).toThrow(/effect/);
		expect(() => effectPin(JSON.stringify({dependencies: {effect: "catalog:"}}))).toThrow(/effect/);
	});
});

describe("the verdict", () => {
	const outside = {typecheck: [`${WORK}/example/src/counter.ts`, SDK], test: [SDK]};

	it("passes when every file both phases read lies outside the checkout", () => {
		expect(judge(CHECKOUT, outside)).toEqual({_tag: "Clean", typecheck: 2, test: 1});
	});

	it("names each file a phase read inside the checkout", () => {
		const leaked = `${CHECKOUT}/packages/tuval/src/authoring/index.ts`;
		const verdict = judge(CHECKOUT, {
			typecheck: [...outside.typecheck, leaked],
			test: [leaked, SDK],
		});
		expect(verdict).toEqual({
			_tag: "Leaked",
			offenders: [
				{phase: "typecheck", path: leaked},
				{phase: "test", path: leaked},
			],
		});
		expect(render(verdict)).toContain(`typecheck resolved ${leaked}`);
	});

	it("fails closed when a phase read no file at all, since nothing was observed", () => {
		expect(judge(CHECKOUT, {typecheck: outside.typecheck, test: []})).toEqual({
			_tag: "Unobserved",
			phase: "test",
		});
	});

	it("fails closed when the test run never reached the SDK's packed files", () => {
		expect(
			judge(CHECKOUT, {
				typecheck: outside.typecheck,
				test: [`${WORK}/example/node_modules/vitest/x.js`],
			}),
		).toEqual({
			_tag: "Unobserved",
			phase: "test",
		});
	});
});
