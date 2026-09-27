import {describe, expect, it} from "vitest";
import {
	belowFloorWarning,
	CLI_PACKAGE,
	compareVersions,
	type FloorSource,
	judgeCliFloor,
	parseVersion,
} from "./cli-floor.ts";

const floorOf = (minimum: unknown): FloorSource => ({
	_tag: "Text",
	text: JSON.stringify({description: "d", minimum}),
});

describe("judgeCliFloor", () => {
	it("warns when the running CLI is older than the minimum", () => {
		expect(judgeCliFloor({installed: "0.5.0", floor: floorOf("0.7.1")})).toEqual({
			_tag: "Below",
			installed: "0.5.0",
			minimum: "0.7.1",
		});
	});

	it("is silent at exactly the minimum", () => {
		expect(judgeCliFloor({installed: "0.7.1", floor: floorOf("0.7.1")})._tag).toBe("Met");
	});

	it("is silent above the minimum", () => {
		expect(judgeCliFloor({installed: "0.10.0", floor: floorOf("0.9.3")})._tag).toBe("Met");
		expect(judgeCliFloor({installed: "1.0.0", floor: floorOf("0.99.99")})._tag).toBe("Met");
	});

	it.each<[string, FloorSource]>([
		["a floor file that could not be read", {_tag: "Unreadable", reason: "ENOENT"}],
		["a floor file that is not JSON", {_tag: "Text", text: "minimum: 0.7.1"}],
		["a floor file with no minimum", {_tag: "Text", text: "{}"}],
		["a floor file that is a JSON array", {_tag: "Text", text: '["0.7.1"]'}],
		["a minimum that is not a string", floorOf(7)],
		["a minimum that is not semver", floorOf("latest")],
	])("is UNKNOWN, never a pass, on %s", (_label, floor) => {
		expect(judgeCliFloor({installed: "0.7.1", floor})._tag).toBe("Unknown");
	});

	it("is UNKNOWN when the running CLI's own version is not semver", () => {
		expect(judgeCliFloor({installed: "dev", floor: floorOf("0.7.1")})._tag).toBe("Unknown");
	});

	it("carries the read failure's reason through", () => {
		const verdict = judgeCliFloor({
			installed: "0.7.1",
			floor: {_tag: "Unreadable", reason: "ENOENT: no such file"},
		});
		expect(verdict).toEqual({_tag: "Unknown", reason: "ENOENT: no such file"});
	});
});

describe("compareVersions", () => {
	const order = (a: string, b: string) => {
		const left = parseVersion(a);
		const right = parseVersion(b);
		if (left === undefined || right === undefined) throw new Error(`unparseable: ${a} ${b}`);
		return compareVersions(left, right);
	};

	it("compares each core field numerically, not as text", () => {
		expect(order("0.10.0", "0.9.0")).toBe(1);
		expect(order("0.7.1", "0.7.10")).toBe(-1);
		expect(order("2.0.0", "10.0.0")).toBe(-1);
	});

	it("ranks a prerelease below its release and follows semver's identifier rules", () => {
		expect(order("0.8.0-rc.1", "0.8.0")).toBe(-1);
		expect(order("0.8.0-rc.2", "0.8.0-rc.10")).toBe(-1);
		expect(order("0.8.0-alpha", "0.8.0-alpha.1")).toBe(-1);
		expect(order("0.8.0-1", "0.8.0-alpha")).toBe(-1);
		expect(order("0.8.0-rc.1", "0.7.9")).toBe(1);
	});

	it("ignores build metadata", () => {
		expect(order("0.7.1+abc", "0.7.1")).toBe(0);
	});

	it("parses no leading-zero or partial versions", () => {
		expect(parseVersion("0.7")).toBeUndefined();
		expect(parseVersion("01.7.1")).toBeUndefined();
		expect(parseVersion("^0.7.1")).toBeUndefined();
	});
});

describe("belowFloorWarning", () => {
	it("names the installed version, the minimum, and the upgrade command", () => {
		const warning = belowFloorWarning({installed: "0.5.0", minimum: "0.7.1"});
		expect(warning).toContain("v0.5.0");
		expect(warning).toContain("v0.7.1");
		expect(warning).toContain(`pnpm add --save-dev ${CLI_PACKAGE}@latest`);
	});
});
