import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams} from "../fakes.test-support.ts";
import {type Attempt, fail, ok, type Shell} from "../io/git.ts";
import {readLocalFileSet} from "./local-file-set.ts";

const RANGE = {base: "aaaaaaa", tip: "bbbbbbb"};

/** The spawner the shared read declares but a scripted reader never reaches. */
const SEAMS = fakeSeams([]).layer;

const run = (
	declared: number,
	read: () => Shell<Attempt<ReadonlyArray<string>>>,
	// biome-ignore lint/suspicious/useAwait: the layer makes this Effect asynchronous to settle.
) =>
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
