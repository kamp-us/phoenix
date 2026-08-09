import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeShell, fakeShell, faultingShell, okOut} from "../fakes.test-support.ts";
import {fetchAndResolve, isObjectName, matchRemote, parseOwnerRepo, splitRemoteRef} from "./git.ts";

const REMOTE_V = `origin\tgit@github.com:kamp-us/phoenix.git (fetch)
origin\tgit@github.com:kamp-us/phoenix.git (push)
upstream\thttps://github.com/someone/fork.git (fetch)
upstream\thttps://github.com/someone/fork.git (push)`;

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

describe("matchRemote", () => {
	it("names the remote serving a repo, in either URL spelling and either case", () => {
		expect(matchRemote(REMOTE_V, "kamp-us/phoenix")).toBe("origin");
		expect(matchRemote(REMOTE_V, "Kamp-Us/Phoenix")).toBe("origin");
		expect(matchRemote(REMOTE_V, "someone/fork")).toBe("upstream");
	});

	it("is null when this checkout serves some other repository — never a guess", () => {
		expect(matchRemote(REMOTE_V, "other/thing")).toBeNull();
		expect(matchRemote("", "kamp-us/phoenix")).toBeNull();
	});
});

describe("fetchAndResolve — fetched before it is read", () => {
	const shell = (extra: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = []) =>
		fakeShell([
			...extra,
			[/^git remote$/, okOut("origin\n")],
			[/^git fetch/, okOut("")],
			[/^git rev-parse/, okOut("49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82\n")],
		]);

	const run = (s: FakeShell, base: string) =>
		Effect.runPromise(Effect.provide(fetchAndResolve(base), s.layer));

	it("fetches, then resolves to a sha", async () => {
		await expect(run(shell(), "origin/main")).resolves.toEqual({
			_tag: "Ok",
			value: "49a22902d1e0c7b3f5a8e4126b9d0f3c7a1e5b82",
		});
	});

	it("fetches BEFORE resolving — a stale local ref is never what gets read", async () => {
		const s = shell();
		await run(s, "origin/main");
		const fetchAt = s.calls.findIndex((c) => c.includes(" fetch"));
		const resolveAt = s.calls.findIndex((c) => c.includes("rev-parse"));
		expect(fetchAt).toBeGreaterThanOrEqual(0);
		expect(fetchAt).toBeLessThan(resolveAt);
	});

	it("refuses when the fetch fails", async () => {
		const result = await run(
			shell([[/^git fetch/, errOut("couldn't find remote ref")]]),
			"origin/nope",
		);
		expect(result).toEqual({_tag: "Failure", reason: "couldn't find remote ref"});
	});

	it("refuses when git answers with something that is not an object name", async () => {
		const result = await run(shell([[/^git rev-parse/, okOut("HEAD -> main\n")]]), "origin/main");
		expect(result._tag).toBe("Failure");
	});

	it("refuses when the SPAWN faults — an absent `git` is never a resolved base", async () => {
		const result = await Effect.runPromise(
			Effect.provide(fetchAndResolve("origin/main"), faultingShell),
		);
		expect(result._tag).toBe("Failure");
		expect(result._tag === "Failure" && result.reason).toContain("spawn git ENOENT");
	});
});
