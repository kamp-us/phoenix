import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {
	DIR,
	LANGUAGE_NO_ROWS,
	LANGUAGE_PATH,
	REPO,
	TERMS,
	TERMS_PATH,
} from "./fixtures.test-support.ts";
import {runSections} from "./sections-verb.ts";

const options = {register: "terms", dir: DIR, json: false, cwd: REPO};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runSections({...options, ...overrides}), fs.layer));

describe("runSections", () => {
	it("names each section and its data-row count, in file order", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			"terms\tCore / shape\t2\nterms\tProducts (domains)\t3\nterms\tIndexing\t1\n",
		);
	});

	// A `^#` scan counts the prose line beginning `#3227).` as a section; the required space does not.
	it("does not report a prose line beginning with a hash as a section", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}));
		expect(out.stdout).not.toContain("3227");
	});

	it("answers the bootstrap line for an absent register — never empty stdout", async () => {
		const out = await run(fakeFs({files: {}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("-\tbootstrap\t0\n");
	});

	it("answers the bootstrap line for a register with prose and no heading", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: LANGUAGE_NO_ROWS}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("-\tbootstrap\t0\n");
	});

	it("refuses when rows exist under no heading — content it can see and cannot place", async () => {
		const out = await run(
			fakeFs({
				files: {[TERMS_PATH]: "| Term | Definition | Not |\n|---|---|---|\n| pano | x | |\n"},
			}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('carries 1 table row(s) under no "## " heading');
	});

	it("refuses an unreadable register — UNKNOWN, never empty", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}, unreadable: [TERMS_PATH]}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("never empty");
	});

	it("refuses an off-enum --register", async () => {
		const out = await run(fakeFs({files: {}}), {register: "glossary"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'glossary sections: --register "glossary" is not one of terms, language, both.',
		);
	});

	it("answers both registers, and one absent register never fails the other", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}), {register: "both"});
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n").filter((line) => line !== "")).toHaveLength(4);
		expect(out.stdout).toContain("-\tbootstrap\t0");
	});

	it("names each register and its byte length on stderr", async () => {
		const out = await run(
			fakeFs({files: {[TERMS_PATH]: TERMS, [LANGUAGE_PATH]: LANGUAGE_NO_ROWS}}),
			{register: "both"},
		);
		expect(out.stderr[0]).toContain(
			`${DIR}/TERMS.md — ${new TextEncoder().encode(TERMS).length} byte(s)`,
		);
		expect(out.stderr[1]).toContain(`${DIR}/LANGUAGE.md`);
	});

	it("emits the JSON array on stdout", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}), {json: true});
		expect(JSON.parse(out.stdout)).toEqual([
			{register: "terms", section: "Core / shape", rows: 2},
			{register: "terms", section: "Products (domains)", rows: 3},
			{register: "terms", section: "Indexing", rows: 1},
		]);
	});
});
