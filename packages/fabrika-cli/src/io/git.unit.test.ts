import {describe, expect, it} from "vitest";
import {errOut, fakeExec, okOut} from "../fakes.test-support.ts";
import {fetchAndResolve, isObjectName, parseOwnerRepo, splitRemoteRef} from "./git.ts";

describe("isObjectName", () => {
	it("accepts a 40-hex sha and rejects anything else", () => {
		expect(isObjectName("49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82")).toBe(true);
		expect(isObjectName("not-a-sha")).toBe(false);
		expect(isObjectName("")).toBe(false);
	});
});

describe("splitRemoteRef", () => {
	it("splits a configured remote's ref so the fetch names it", () => {
		expect(splitRemoteRef("origin/main", ["origin"])).toEqual({remote: "origin", ref: "main"});
	});

	it("is null for a ref naming no configured remote", () => {
		expect(splitRemoteRef("main", ["origin"])).toBeNull();
		expect(splitRemoteRef("upstream/main", ["origin"])).toBeNull();
	});
});

describe("parseOwnerRepo", () => {
	it("reads owner/name from either remote URL spelling", () => {
		expect(parseOwnerRepo("git@github.com:kamp-us/phoenix.git")).toBe("kamp-us/phoenix");
		expect(parseOwnerRepo("https://github.com/kamp-us/phoenix.git\n")).toBe("kamp-us/phoenix");
		expect(parseOwnerRepo("https://github.com/kamp-us/phoenix")).toBe("kamp-us/phoenix");
	});
});

describe("fetchAndResolve — fetched before it is read", () => {
	const script = (extra: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
		fakeExec([
			...extra,
			[/^git remote$/, okOut("origin\n")],
			[/^git fetch/, okOut("")],
			[/^git rev-parse/, okOut("49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82\n")],
		]);

	it("fetches, then resolves to a sha", () => {
		expect(fetchAndResolve(script(), "origin/main")).toEqual({
			_tag: "Ok",
			value: "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82",
		});
	});

	it("fetches BEFORE resolving — a stale local ref is never what gets read", () => {
		const calls: string[] = [];
		const exec = (file: string, args: ReadonlyArray<string>) => {
			calls.push([file, ...args].join(" "));
			if (args[0] === "remote") return okOut("origin\n");
			if (args[0] === "fetch") return okOut("");
			return okOut("49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82\n");
		};
		fetchAndResolve(exec, "origin/main");
		const fetchAt = calls.findIndex((c) => c.includes(" fetch"));
		const resolveAt = calls.findIndex((c) => c.includes("rev-parse"));
		expect(fetchAt).toBeGreaterThanOrEqual(0);
		expect(fetchAt).toBeLessThan(resolveAt);
	});

	it("refuses when the fetch fails", () => {
		const result = fetchAndResolve(
			script([[/^git fetch/, errOut("couldn't find remote ref")]]),
			"origin/nope",
		);
		expect(result).toEqual({_tag: "Failure", reason: "couldn't find remote ref"});
	});

	it("refuses when git answers with something that is not an object name", () => {
		const result = fetchAndResolve(
			script([[/^git rev-parse/, okOut("HEAD -> main\n")]]),
			"origin/main",
		);
		expect(result._tag).toBe("Failure");
	});
});
