/**
 * `lane view` — what this verb owns.
 *
 * Reading a lane directory is `@demlik/tea`'s (`lanesFromDisk`) and is covered there: the two-file
 * convention, a directory that is not a lane, a lane emitted and never run. What is fabrika's is
 * the refusal when the root cannot be listed, and the sentence a driver reads.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {DEFAULT_LANES_ROOT} from "./store.ts";
import {listeningAt, runView} from "./view-verb.ts";

const ROOT = DEFAULT_LANES_ROOT;

describe("lane view — what it refuses", () => {
	it("refuses a root that is there and cannot be listed, rather than serving a short list", async () => {
		const fs = fakeFs({files: {}, dirs: {}, directories: [ROOT], unreadable: [ROOT]});
		const out = await Effect.runPromise(Effect.provide(runView({root: ROOT, port: 0}), fs.layer));

		expect(out.code).toBe(LANE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join(" ")).toContain("UNKNOWN");
	});
});

describe("lane view — what a driver reads", () => {
	it("names the port and what the ordering means", () => {
		expect(listeningAt(5411)).toContain("http://localhost:5411");
		expect(listeningAt(5411)).toContain("needing a person first");
	});
});
