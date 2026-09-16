import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams} from "../fakes.test-support.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {PULL_FILES_CAP} from "../io/pulls.ts";
import {platformCapLine, platformFileSet, readLocalFileSet} from "./local-file-set.ts";

const RANGE = {base: "aaaaaaa", tip: "bbbbbbb"};

/** The spawner the shared read declares but a scripted reader never reaches. */
const SEAMS = fakeSeams([]).layer;

const run = (declared: number, read: () => Shell<Attempt<ReadonlyArray<string>>>) =>
	Effect.runPromise(
		Effect.provide(
			readLocalFileSet("review scope", "#4321", RANGE, declared, read),
			Layer.orDie(SEAMS),
		),
	);

const listing = (files: ReadonlyArray<string>) => () => Effect.succeed(ok(files));

describe("readLocalFileSet", () => {
	it("proceeds on the local set when GitHub declares more files, and names the disagreement", async () => {
		const out = await run(40, listing(["a.ts", "b.ts"]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.files).toEqual(["a.ts", "b.ts"]);
		expect(out.set.disagreement).toBe(
			"review scope: git and GitHub disagree on #4321's file count (2 vs 40) — different merge base and different rename detection; reported, never refused on.",
		);
	});

	it("reports no disagreement when the two counts agree", async () => {
		const out = await run(2, listing(["a.ts", "b.ts"]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.disagreement).toBeNull();
	});

	it("names the disagreement in the other direction too — the local read can be the longer one", async () => {
		const out = await run(1, listing(["a.ts", "b.ts"]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.disagreement).toContain("(2 vs 1)");
	});

	it("carries an unreadable range's reason instead of an empty set", async () => {
		const out = await run(2, () => Effect.succeed(fail("fatal: bad revision")));
		expect(out).toEqual({_tag: "Unreadable", reason: "fatal: bad revision"});
	});
});

describe("platformFileSet", () => {
	it("proceeds on the enumerated list and names the two platform reads it compares", () => {
		const out = platformFileSet("ship gate", "#4321", 40, ok(["a.ts", "b.ts"]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.files).toEqual(["a.ts", "b.ts"]);
		expect(out.set.disagreement).toBe(
			"ship gate: GitHub's file list for #4321 holds 2 paths against the 40 its own pull-request record declares — the record's count is computed against a base cached at the last push; reported, never refused on.",
		);
	});

	it("reports no disagreement when the two counts agree", () => {
		const out = platformFileSet("ship gate", "#4321", 2, ok(["a.ts", "b.ts"]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.disagreement).toBeNull();
	});

	// The wording is the one thing a caller must not restate: `disagreementLine`'s "git and GitHub"
	// is false here, because both counts come off the platform.
	it("never borrows the git-versus-GitHub wording", () => {
		const out = platformFileSet("ship floor", "#4321", 40, ok([]));
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.disagreement).not.toContain("git and GitHub");
	});

	it("carries an unreadable list's reason instead of an empty set", () => {
		expect(platformFileSet("ship gate", "#4321", 2, fail("502 Bad Gateway"))).toEqual({
			_tag: "Unreadable",
			reason: "502 Bad Gateway",
		});
	});

	// The endpoint's ceiling is reached through ordinary paging, so the exhaustion proof passes over
	// a list GitHub already truncated. The fact rides beside the files rather than being re-derived.
	it("raises `capped` when the list reaches the endpoint's ceiling", () => {
		const at = platformFileSet(
			"ship gate",
			"#4321",
			PULL_FILES_CAP,
			ok(Array.from({length: PULL_FILES_CAP}, (_, i) => `f${i}.ts`)),
		);
		expect(at._tag).toBe("Read");
		if (at._tag !== "Read") return;
		expect(at.set.capped).toBe(true);
	});

	it("leaves `capped` false one file below the ceiling", () => {
		const under = platformFileSet(
			"ship gate",
			"#4321",
			PULL_FILES_CAP - 1,
			ok(Array.from({length: PULL_FILES_CAP - 1}, (_, i) => `f${i}.ts`)),
		);
		expect(under._tag).toBe("Read");
		if (under._tag !== "Read") return;
		expect(under.set.capped).toBe(false);
	});
});

// A git range has no platform ceiling, so the local read can never raise the fact — the callers that
// refuse on it are exactly the three reading `pulls/<n>/files`.
describe("the ceiling belongs to the platform read alone", () => {
	it("never raises `capped` on a local range read", async () => {
		const out = await run(
			PULL_FILES_CAP,
			listing(Array.from({length: PULL_FILES_CAP}, (_, i) => `f${i}.ts`)),
		);
		expect(out._tag).toBe("Read");
		if (out._tag !== "Read") return;
		expect(out.set.capped).toBe(false);
	});

	it("names the ceiling in one place, with the caller's consequence as the tail", () => {
		expect(platformCapLine("ship floor", "#4321", "a governance root could sit in it.")).toBe(
			"ship floor: GitHub's file list for #4321 came back at its 3000-file ceiling, so the list is provably partial — a governance root could sit in it.",
		);
	});
});
