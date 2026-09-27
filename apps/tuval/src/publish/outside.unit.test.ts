import {describe, expect, it} from "vitest";
import {effectPin, judge, packedDeskFindings, placement, render, resolvedFiles} from "./outside.ts";

const CHECKOUT = "/home/ci/phoenix";
const WORK = "/tmp/tuval-desk-outside-abc";
const MODULES = `${WORK}/author/node_modules`;
const DESK = `${MODULES}/@kampus/tuval/server/bin.js`;
const SDK = `${MODULES}/@kampus/tuval-sdk/dist/config.js`;

const packed = {
	name: "@kampus/tuval",
	version: "0.0.0",
	bin: {tuval: "./server/bin.js"},
	exports: {"./package.json": "./package.json"},
	dependencies: {"@kampus/tuval-sdk": "0.0.0", effect: "4.0.0-rc.112"},
};
const entries = ["package/package.json", "package/server/bin.js", "package/index.html"];

describe("where the author's folder is", () => {
	it("accepts a directory beside the checkout, even one sharing its name as a prefix", () => {
		expect(placement(CHECKOUT, WORK)).toEqual({_tag: "Outside"});
		expect(placement(CHECKOUT, "/home/ci/phoenix-tmp/x")).toEqual({_tag: "Outside"});
	});

	it("refuses a directory under the checkout, where resolution could walk up into it", () => {
		expect(placement(CHECKOUT, `${CHECKOUT}/tmp/x`)).toEqual({
			_tag: "Inside",
			path: `${CHECKOUT}/tmp/x`,
		});
	});
});

describe("the packed desk", () => {
	it("finds nothing wrong with @kampus/tuval, its tuval bin, a source-free exports map and the SDK as a dependency", () => {
		expect(packedDeskFindings(JSON.stringify(packed), entries)).toEqual([]);
	});

	it("names each way it falls short", () => {
		const findings = packedDeskFindings(
			JSON.stringify({
				name: "@kampus-apps/tuval",
				bin: {tuval: "./server/missing.js"},
				exports: {".": {types: "./src/index.d.ts", default: "./src/index.ts"}},
				dependencies: {"@kampus/tuval-sdk": "workspace:*"},
				bundledDependencies: ["@kampus/tuval-sdk"],
			}),
			[...entries, "package/node_modules/@kampus/tuval-sdk/package.json"],
		);
		expect(findings).toEqual([
			"it packs as @kampus-apps/tuval, not @kampus/tuval",
			"its `tuval` bin names ./server/missing.js, which the tarball does not hold",
			"its exports map names ./src/index.ts",
			"it does not depend on a published @kampus/tuval-sdk (found workspace:*)",
			"it bundles dependencies into the tarball",
			"the tarball holds package/node_modules/@kampus/tuval-sdk/package.json",
		]);
	});

	it("names a missing bin, a missing exports map and a missing SDK dependency", () => {
		expect(
			packedDeskFindings(JSON.stringify({name: "@kampus/tuval", dependencies: {}}), entries),
		).toEqual([
			"it declares no `tuval` bin",
			"it has no exports map",
			"it does not depend on a published @kampus/tuval-sdk (found undefined)",
		]);
	});
});

describe("the effect pin", () => {
	it("reads the exact effect version off the packed SDK's manifest", () => {
		expect(effectPin(JSON.stringify({dependencies: {effect: "4.0.0-rc.112"}}))).toBe(
			"4.0.0-rc.112",
		);
	});

	it("refuses a manifest whose effect is still a workspace spec", () => {
		expect(() => effectPin(JSON.stringify({dependencies: {effect: "catalog:"}}))).toThrow(
			/pins no published effect version/,
		);
	});
});

describe("reading what the desk resolved", () => {
	it("keeps only file URLs, once each, without a reload's generation stamp", () => {
		const log = [
			"node:fs",
			`file://${SDK}`,
			`file://${WORK}/author/greeter.ts?tuval-load=2`,
			`file://${SDK}`,
			"",
		].join("\n");
		expect(resolvedFiles(log)).toEqual([SDK, `${WORK}/author/greeter.ts`]);
	});
});

describe("the verdict", () => {
	it("is clean when the desk and one SDK were loaded from the author's folder alone", () => {
		const verdict = judge(CHECKOUT, [
			DESK,
			SDK,
			`${MODULES}/@kampus/tuval-sdk/dist/authoring/index.js`,
		]);
		expect(verdict).toEqual({_tag: "Clean", files: 3, sdk: `${MODULES}/@kampus/tuval-sdk`});
		expect(render(verdict)).toContain("one @kampus/tuval-sdk");
	});

	it("names every file resolved inside the checkout", () => {
		const inside = `${CHECKOUT}/packages/tuval/src/config.ts`;
		expect(judge(CHECKOUT, [DESK, SDK, inside])).toEqual({_tag: "Leaked", paths: [inside]});
	});

	it("names both roots when a second SDK copy was loaded", () => {
		const nested = `${MODULES}/@kampus/tuval/node_modules/@kampus/tuval-sdk/dist/config.js`;
		expect(judge(CHECKOUT, [DESK, SDK, nested])).toEqual({
			_tag: "TwoSdks",
			roots: [
				`${MODULES}/@kampus/tuval-sdk`,
				`${MODULES}/@kampus/tuval/node_modules/@kampus/tuval-sdk`,
			],
		});
	});

	it("proves nothing when the installed desk or SDK was never loaded", () => {
		expect(judge(CHECKOUT, [SDK])._tag).toBe("Unobserved");
		expect(judge(CHECKOUT, [DESK])).toEqual({
			_tag: "Unobserved",
			what: "the installed @kampus/tuval-sdk",
		});
	});
});
