import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {BAD_SECTIONS, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {DIR, LANGUAGE_PATH, REPO, TERMS, TERMS_PATH} from "./fixtures.test-support.ts";
import {runLookup} from "./lookup-verb.ts";

const options = {terms: ["pano"], register: "terms", dir: DIR, json: false, cwd: REPO};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runLookup({...options, ...overrides}), fs.layer));

const populated = () => fakeFs({files: {[TERMS_PATH]: TERMS}});

describe("runLookup", () => {
	it("answers declared with the first matching row's section and cell", async () => {
		const out = await run(populated());
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("declared\tterms\tCore / shape\tpano\n");
	});

	// A parenthetical is a disambiguating qualifier, not an alias — the v1 split produced three
	// false duplicates (#4206), so `tag` overlaps `Database (tag)` rather than equalling it.
	it("answers collision for a whole-word overlap, not declared", async () => {
		const out = await run(populated(), {terms: ["tag"]});
		expect(out.stdout).toBe("collision\tterms\tIndexing\tDatabase (tag)\n");
	});

	// The normalization folds a hyphen to a SPACE (contract §normalization step 3), which is what
	// makes `front-door` and `front door` one key — the #4481 defect. It follows that `de-po`
	// normalizes to `de po`, which is NOT `depo`: the contract's own `de-po` → `depo` example is
	// unreachable under the algorithm the same document fixes. Pinned in both directions so the
	// divergence is a measured fact rather than a reading.
	it("folds a hyphen to a space, so `front-door` and `front door` are one key", async () => {
		const io = fakeFs({
			files: {
				[TERMS_PATH]: `## S

| Term | Definition | Not |
|---|---|---|
| front-door | The entry surface. | |
`,
			},
		});
		const out = await run(io, {terms: ["front door"]});
		expect(out.stdout).toBe("declared\tterms\tS\tfront-door\n");
	});

	it("does not fold a hyphen AWAY, so `de-po` does not reach `depo`", async () => {
		const out = await run(populated(), {terms: ["de-po"]});
		expect(out.stdout).toBe("absent\t-\t-\t-\n");
	});

	it("answers absent as a proven fact against a register that was read", async () => {
		const out = await run(populated(), {terms: ["capture ledger"]});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("absent\t-\t-\t-\n");
	});

	it("answers one line per term, in argument order", async () => {
		const out = await run(populated(), {terms: ["depo", "capture ledger"]});
		expect(out.stdout).toBe("declared\tterms\tProducts (domains)\tdepo\nabsent\t-\t-\t-\n");
	});

	it("answers absent for every term against a register that exists and holds no rows", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: "# empty\n\nNo table.\n"}}));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("absent\t-\t-\t-\n");
	});

	it("reports a term declared in BOTH registers once, as declared in TERMS", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS, [LANGUAGE_PATH]: TERMS}}), {
			register: "both",
		});
		expect(out.stdout).toBe("declared\tterms\tCore / shape\tpano\n");
	});

	it("refuses an unreadable register — every state is UNKNOWN, never absent", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}, unreadable: [TERMS_PATH]}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "absent"');
	});

	it("refuses a malformed term table — membership is UNKNOWN, never absent", async () => {
		const out = await run(
			fakeFs({files: {[TERMS_PATH]: "## S\n\n| Term | Definition | Not |\n| pano | x | |\n"}}),
		);
		expect(out.code).toBe(BAD_SECTIONS);
		expect(out.stdout).toBe("");
	});

	it("refuses an off-enum --register", async () => {
		const out = await run(populated(), {register: "sozluk"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("refuses with no term given", async () => {
		const out = await run(populated(), {terms: []});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe("glossary lookup: no term given.");
	});

	it("names the row count per register on stderr", async () => {
		const out = await run(populated());
		expect(out.stderr[0]).toContain("6 row(s)");
	});

	it("emits a JSON array so one term and many parse identically", async () => {
		const out = await run(populated(), {terms: ["pano", "capture ledger"], json: true});
		expect(JSON.parse(out.stdout)).toEqual([
			{
				term: "pano",
				normalized: "pano",
				state: "declared",
				register: "terms",
				section: "Core / shape",
				matched: ["pano"],
			},
			{
				term: "capture ledger",
				normalized: "capture ledger",
				state: "absent",
				register: null,
				section: null,
				matched: [],
			},
		]);
	});
});
