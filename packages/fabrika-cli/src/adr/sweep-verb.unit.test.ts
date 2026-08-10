import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs, record} from "../fakes.test-support.ts";
import {DIR_UNREADABLE, NO_SUBJECT} from "./codes.ts";
import {runSweep} from "./sweep-verb.ts";

const dir = ".decisions";

/** Twelve live records — above the rarity floor — plus a proposed subject. */
const corpus = (): Record<string, string> => {
	const files: Record<string, string> = {};
	for (let i = 0; i < 12; i += 1) {
		files[`${dir}/01${String(i).padStart(2, "0")}-x.md`] = record(
			`01${String(i).padStart(2, "0")}`,
			"accepted",
			i < 3 ? "reticulate the splines" : "gate the thing",
		);
	}
	files[`${dir}/0240-subject.md`] = record("0240", "proposed", "reticulate the splines");
	return files;
};

const fsWith = (files: Record<string, string | null>) =>
	fakeFs({dirs: {[dir]: Object.keys(files).map((p) => p.slice(dir.length + 1))}, files});

const options = {new: "0240", dir, limit: 8, json: false};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runSweep({...options, ...overrides}), fs.layer));

describe("runSweep", () => {
	it("exits 0 WITH a shortlist — the informative case is not a failure", async () => {
		const out = await run(fsWith(corpus()));
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("shortlist");
		expect(out.stdout.split("\n").filter((l) => l !== "").length).toBeGreaterThan(1);
	});

	it("puts the --json payload on STDOUT, not stderr (#4723)", async () => {
		const out = await run(fsWith(corpus()), {json: true});
		expect(out.code).toBe(0);
		const payload = JSON.parse(out.stdout);
		expect(payload.outcome).toBe("shortlist");
		expect(payload.entries.length).toBeGreaterThan(0);
		expect(payload.reason).toBeNull();
		expect(payload).toHaveProperty("scanned");
		expect(payload).toHaveProperty("inScope");
		expect(payload).toHaveProperty("cited");
		expect(out.stderr.join("")).not.toContain('"outcome"');
	});

	it("exits 0 on no-overlap, with the reason on stderr", async () => {
		const files = corpus();
		files[`${dir}/0240-subject.md`] = record("0240", "proposed", "marzipan bicycle telemetry");
		const out = await run(fsWith(files));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("no-overlap\n");
		expect(out.stderr.join("\n")).toContain("not a clearance");
	});

	it("exits 0 on indeterminate below the rarity floor", async () => {
		const files = {
			[`${dir}/0100-x.md`]: record("0100", "accepted", "anything"),
			[`${dir}/0240-subject.md`]: record("0240", "proposed", "anything"),
		};
		const out = await run(fsWith(files));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("indeterminate\n");
		expect(out.stderr.join("\n")).toContain("rarity floor");
	});

	it("states the corpus size and in-scope count on stderr, so indeterminate is readable", async () => {
		const out = await run(fsWith(corpus()));
		expect(out.stderr[0]).toContain("13 decision records");
		expect(out.stderr[0]).toContain("in scope");
	});

	it("refuses an unreadable corpus — UNKNOWN, never no-overlap", async () => {
		const out = await run(fakeFs({dirs: {[dir]: null}}));
		expect(out.code).toBe(DIR_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "no-overlap"');
	});

	it("refuses when ONE corpus member is unreadable rather than ranking against the rest", async () => {
		const files: Record<string, string | null> = corpus();
		files[`${dir}/0105-x.md`] = null;
		const out = await run(fsWith(files));
		expect(out.code).toBe(DIR_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	// A readable-but-empty corpus is the rarity floor at its limit, not a failed read — the fresh
	// adopter sweeping their very first draft gets an answer (#5254).
	it("answers indeterminate against a readable-but-empty --dir", async () => {
		const io = fakeFs({
			dirs: {[dir]: []},
			files: {"drafts/0001-draft.md": record("0001", "proposed", "reticulate the splines")},
		});
		const out = await run(io, {new: "drafts/0001-draft.md"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("indeterminate\n");
		expect(out.stderr.join("\n")).toContain("rarity floor");
		expect(out.stderr[0]).toContain("0 decision records");
	});

	it("refuses when --new names no readable ADR", async () => {
		const out = await run(fsWith(corpus()), {new: "9999"});
		expect(out.code).toBe(NO_SUBJECT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe("adr sweep: no readable ADR for --new 9999.");
	});

	it("accepts --new as a path to a draft outside the corpus", async () => {
		const files: Record<string, string | null> = corpus();
		files["/drafts/0300-draft.md"] = record("0300", "proposed", "reticulate the splines");
		const io = fakeFs({
			dirs: {[dir]: Object.keys(corpus()).map((p) => p.slice(dir.length + 1))},
			files,
		});
		const out = await run(io, {new: "/drafts/0300-draft.md"});
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("shortlist");
	});

	it("honours --limit", async () => {
		const out = await run(fsWith(corpus()), {limit: 1});
		expect(out.stdout.split("\n").filter((l) => l !== "")).toHaveLength(2);
	});
});
