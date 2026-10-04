import {Result} from "effect";
import {describe, expect, it} from "vitest";
import {admitSdk, defaultSdkRange, SdkOutOfRange, SdkRangeMalformed} from "./sdk-range.ts";

describe("admitSdk", () => {
	it("admits a program whose range includes the desk's SDK, answering the range", () => {
		expect(admitSdk("notify", "^1.2", "1.4.0")).toStrictEqual(Result.succeed("^1.2"));
		expect(admitSdk("notify", ">=1 <3", "2.0.0")).toStrictEqual(Result.succeed(">=1 <3"));
	});

	it("refuses a program whose range excludes the desk's SDK, naming the program, range and version", () => {
		const refused = admitSdk("notify", "^2", "1.4.0");
		expect(refused).toStrictEqual(
			Result.fail(new SdkOutOfRange({program: "notify", range: "^2", sdk: "1.4.0"})),
		);
		if (Result.isSuccess(refused)) throw new Error("expected a refusal");
		expect(refused.failure.message).toBe(
			'program "notify" supports @kampus/tuval-sdk ^2, and this desk runs 1.4.0; it was not loaded',
		);
	});

	it("refuses a range that is not a semver range, and one that is not a string", () => {
		const refused = admitSdk("notify", "banana", "1.4.0");
		expect(refused).toStrictEqual(
			Result.fail(new SdkRangeMalformed({program: "notify", range: "banana", sdk: "1.4.0"})),
		);
		if (Result.isSuccess(refused)) throw new Error("expected a refusal");
		expect(refused.failure.message).toBe(
			'program "notify" declares @kampus/tuval-sdk range "banana", which is not a semver range (this desk runs 1.4.0); it was not loaded',
		);
		expect(admitSdk("notify", 1, "1.4.0")).toStrictEqual(
			Result.fail(new SdkRangeMalformed({program: "notify", range: "1", sdk: "1.4.0"})),
		);
	});

	it("admits a program that declares no range on every SDK of the desk's own major", () => {
		expect(defaultSdkRange("0.0.0")).toBe("^0");
		expect(admitSdk("notify", undefined, "0.0.0")).toStrictEqual(Result.succeed("^0"));
		expect(admitSdk("notify", undefined, "1.9.3")).toStrictEqual(Result.succeed("^1"));
	});

	it("compares a prerelease desk SDK as the release it leads up to", () => {
		expect(Result.isSuccess(admitSdk("notify", "^1", "1.0.0-rc.1"))).toBe(true);
		expect(Result.isSuccess(admitSdk("notify", undefined, "1.0.0-rc.1"))).toBe(true);
	});

	it("admits the range every in-repo program declares on the SDK this repo ships", () => {
		expect(Result.isSuccess(admitSdk("notify", "0.x", "0.0.0"))).toBe(true);
	});
});
