import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {SLUG_MALFORMED} from "./codes.ts";
import {allocationDir, runScratch} from "./scratch-verb.ts";

const ALLOCATION = "a1b2c3d4-0000-4000-8000-000000000000";

const options = {slug: "body", allocation: ALLOCATION, tmpRoot: "/scratch-root"};

const run = (overrides: Partial<typeof options> = {}, fs = fakeFs({})) =>
	Effect.runPromise(Effect.provide(runScratch({...options, ...overrides}), fs.layer));

describe("runScratch", () => {
	it("prints one absolute path keyed on the allocation id", async () => {
		const out = await run();
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`/scratch-root/fabrika-report/${ALLOCATION}/body\n`);
	});

	/**
	 * A reporter holds no claim, so the id is the only thing keeping two concurrent filings of one
	 * session off each other's file — the clobber `build scratch` keys a claim nonce against.
	 */
	it("gives two allocations of one session different directories", async () => {
		const first = await run();
		const second = await run({allocation: "ffffffff-0000-4000-8000-000000000000"});
		expect(first.stdout).not.toBe(second.stdout);
	});

	it("refuses a slug carrying a path separator", async () => {
		const out = await run({slug: "sub/body"});
		expect(out.code).toBe(SLUG_MALFORMED);
		expect(out.stderr.join("\n")).toContain("kebab-case leaf");
	});

	it("refuses a slug that is not kebab-case", async () => {
		const out = await run({slug: "Body_1"});
		expect(out.code).toBe(SLUG_MALFORMED);
	});

	/**
	 * The shared predicate caps a slug at five hyphen-separated words, so a sixth is refused even
	 * though the value is a kebab-case leaf. The message has to name that bound: a caller told only
	 * "kebab-case leaf, no path separators" is told its value is something it already is.
	 */
	it("refuses a kebab-case leaf past five words, naming the bound", async () => {
		const out = await run({slug: "pull-request-body-for-lane-nine"});
		expect(out.code).toBe(SLUG_MALFORMED);
		expect(out.stderr.join("\n")).toContain("≤5 words");
	});

	it("refuses on the universal 1 when the directory cannot be created", async () => {
		const dir = allocationDir("/scratch-root", ALLOCATION);
		const out = await run({}, fakeFs({unwritable: [dir]}));
		expect(out.code).toBe(FAILED);
		expect(out.stderr.join("\n")).toContain("cannot create");
	});

	it("derives the directory through the exported formula, trailing slash or not", () => {
		expect(allocationDir("/scratch-root/", "x")).toBe("/scratch-root/fabrika-report/x");
	});
});
