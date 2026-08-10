import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {FAILED} from "../verb.ts";
import {ALREADY_EXISTS} from "./codes.ts";
import {type NewOptions, runNew} from "./new-verb.ts";

const options: NewOptions = {
	id: "0240",
	slug: "only-landed-adrs-may-be-cited",
	dir: ".decisions",
	status: "accepted",
	date: "2026-08-01",
	title: null,
	tags: null,
	json: false,
};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runNew({...options, ...overrides}), fs.layer));

describe("runNew", () => {
	it("writes the record and prints its path", async () => {
		const fs = fakeFs({});
		const out = await run(fs);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(".decisions/0240-only-landed-adrs-may-be-cited.md\n");
		expect(fs.written.get(".decisions/0240-only-landed-adrs-may-be-cited.md")).toContain(
			"id: 0240",
		);
	});

	it("--json carries path, id and slug", async () => {
		const out = await run(fakeFs({}), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			path: ".decisions/0240-only-landed-adrs-may-be-cited.md",
			id: "0240",
			slug: "only-landed-adrs-may-be-cited",
		});
	});

	it("refuses to overwrite an existing record and writes nothing", async () => {
		const fs = fakeFs({files: {".decisions/0126-ambient-adr-discovery.md": "existing"}});
		const out = await run(fs, {id: "0126", slug: "ambient-adr-discovery"});
		expect(out.code).toBe(ALREADY_EXISTS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"adr new: .decisions/0126-ambient-adr-discovery.md already exists — refusing to overwrite.",
		);
		expect(fs.written.size).toBe(0);
	});

	it("refuses an id that is not four zero-padded digits", async () => {
		const out = await run(fakeFs({}), {id: "240"});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toBe('adr new: id "240" is not four zero-padded digits.');
	});

	it("refuses a slug that is not kebab-case", async () => {
		const out = await run(fakeFs({}), {slug: "Not Kebab"});
		expect(out.code).toBe(FAILED);
		expect(out.stderr.at(-1)).toContain("is not kebab-case");
	});

	it("refuses — rather than reporting success — when the write itself fails", async () => {
		const fs = fakeFs({unwritable: [".decisions/0240-only-landed-adrs-may-be-cited.md"]});
		const out = await run(fs);
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
	});

	it("refuses an existence probe that FAILED, rather than reading it as 'absent' and writing", async () => {
		const fs = fakeFs({unprobeable: [".decisions/0240-only-landed-adrs-may-be-cited.md"]});
		const out = await run(fs);
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
		expect(fs.written.size).toBe(0);
	});

	it("uses --title and --tags when given", async () => {
		const fs = fakeFs({});
		await run(fs, {title: "A real title", tags: "decisions,gates"});
		const written = fs.written.get(".decisions/0240-only-landed-adrs-may-be-cited.md") ?? "";
		expect(written).toContain("title: A real title");
		expect(written).toContain("tags: [decisions, gates]");
		expect(written).toContain("# 0240 — A real title");
	});
});
