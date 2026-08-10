import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, TERM_COLLISION, WRITE_UNKNOWN} from "./codes.ts";
import {DIR, LANGUAGE_PATH, REPO, TERMS, TERMS_PATH} from "./fixtures.test-support.ts";
import {runInit} from "./init-verb.ts";
import {registerTemplate} from "./template.ts";

const options = {register: "terms", dir: DIR, json: false, cwd: REPO};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runInit({...options, ...overrides}), fs.layer));

describe("runInit", () => {
	it("writes the template and reports the path it created", async () => {
		const io = fakeFs({files: {}});
		const out = await run(io);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`created\t${DIR}/TERMS.md\n`);
		expect(io.written.get(TERMS_PATH)).toBe(registerTemplate("repo", "terms"));
	});

	it("names the target repo's own directory in the H1, not a hardcoded one", async () => {
		const io = fakeFs({files: {}});
		await run(io, {cwd: "/somewhere/other-repo"});
		expect(io.written.get("/somewhere/other-repo/.glossary/TERMS.md")).toContain(
			"# other-repo domain vocabulary (TERMS)",
		);
	});

	it("scaffolds no section — an empty one invites filler", async () => {
		const io = fakeFs({files: {}});
		await run(io);
		expect(io.written.get(TERMS_PATH)).not.toContain("\n## ");
	});

	it("writes the LANGUAGE register under its own heading", async () => {
		const io = fakeFs({files: {}});
		const out = await run(io, {register: "language"});
		expect(out.stdout).toBe(`created\t${DIR}/LANGUAGE.md\n`);
		expect(io.written.get(LANGUAGE_PATH)).toContain("# repo architecture vocabulary (LANGUAGE)");
	});

	it("refuses to overwrite an existing register", async () => {
		const out = await run(fakeFs({files: {[TERMS_PATH]: TERMS}}));
		expect(out.code).toBe(TERM_COLLISION);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			`glossary init: ${DIR}/TERMS.md already exists — refusing to overwrite a register.`,
		);
	});

	it("refuses --register both — the two are never created by one ambiguous call", async () => {
		const out = await run(fakeFs({files: {}}), {register: "both"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"glossary init: --register both is not creatable — create each register explicitly.",
		);
	});

	it("refuses an off-enum --register", async () => {
		const out = await run(fakeFs({files: {}}), {register: "sozluk"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			'glossary init: --register "sozluk" is not one of terms, language.',
		);
	});

	it("reports a failed write as UNKNOWN, never as created", async () => {
		const io = fakeFs({files: {}, unwritable: [TERMS_PATH]});
		const out = await run(io);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(io.written.size).toBe(0);
	});

	// A probe that could not be performed is UNKNOWN, never "absent" — answering absent would license
	// a write over a register this process never managed to look at.
	it("refuses when the existence probe itself fails", async () => {
		const out = await run(fakeFs({files: {}, unprobeable: [TERMS_PATH]}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
	});

	it("emits the creation record as JSON", async () => {
		const out = await run(fakeFs({files: {}}), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			action: "created",
			path: `${DIR}/TERMS.md`,
			register: "terms",
		});
	});
});
