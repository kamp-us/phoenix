import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runAdd} from "./add-verb.ts";
import {
	EDIT_BEYOND_ROW,
	EMPTY_STDIN,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	ROW_SHAPE_INVALID,
	SECTION_ABSENT,
	TERM_COLLISION,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {DIR, REPO, TERMS, TERMS_PATH} from "./fixtures.test-support.ts";

const piped = (text: string): Effect.Effect<StdinRead> =>
	Effect.succeed({_tag: "Text" as const, text});

const options = {
	term: "capture ledger",
	register: "terms",
	section: "Products (domains)",
	definitionFile: "-",
	notFile: null as string | null,
	replace: false,
	createSection: false,
	dir: DIR,
	json: false,
	cwd: REPO,
	stdin: piped("The append-only record of one capture run."),
};

const run = (fs: FakeFs, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runAdd({...options, ...overrides}), fs.layer));

const populated = () => fakeFs({files: {[TERMS_PATH]: TERMS}});

describe("runAdd", () => {
	it("inserts the row in its section's alphabetical place and reports the line", async () => {
		const io = populated();
		const out = await run(io);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`added\t${DIR}/TERMS.md\tProducts (domains)\t16\n`);
		expect((io.written.get(TERMS_PATH) ?? "").split("\n")[15]).toBe(
			"| capture ledger | The append-only record of one capture run. | |",
		);
	});

	it("moves nothing else — every other line survives byte for byte", async () => {
		const io = populated();
		await run(io);
		const after = (io.written.get(TERMS_PATH) ?? "").split("\n");
		const before = TERMS.split("\n");
		expect([...after.slice(0, 15), ...after.slice(16)]).toEqual(before);
	});

	it("escapes a pipe and flattens a newline, so the row stays one line", async () => {
		const io = populated();
		await run(io, {stdin: piped("one | two\nthree")});
		expect((io.written.get(TERMS_PATH) ?? "").split("\n")[15]).toBe(
			"| capture ledger | one \\| two three | |",
		);
	});

	it("writes the Not cell when --not-file names one", async () => {
		const io = fakeFs({files: {[TERMS_PATH]: TERMS, "/repo/not.txt": "an evidence log"}});
		await run(io, {notFile: "not.txt"});
		expect((io.written.get(TERMS_PATH) ?? "").split("\n")[15]).toContain("| an evidence log |");
	});

	it("refuses a term already declared, naming the section it sits in", async () => {
		const out = await run(populated(), {term: "pano", section: "Core / shape"});
		expect(out.code).toBe(TERM_COLLISION);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			'glossary add: pano is already declared in terms under "Core / shape" — pass --replace to rewrite it.',
		);
	});

	it("rewrites the declared row under --replace and reports its line", async () => {
		const io = populated();
		const out = await run(io, {
			term: "pano",
			section: "Core / shape",
			replace: true,
			stdin: piped("The board product."),
		});
		expect(out.stdout).toBe(`replaced\t${DIR}/TERMS.md\tCore / shape\t9\n`);
		expect((io.written.get(TERMS_PATH) ?? "").split("\n")[8]).toBe(
			"| pano | The board product. | |",
		);
	});

	// The flag asks to rewrite a specific row; adding anyway would hide a wrong belief about the file.
	it("refuses --replace on a term that is not declared", async () => {
		const out = await run(populated(), {replace: true});
		expect(out.code).toBe(TERM_COLLISION);
		expect(out.stderr.at(-1)).toContain("refusing to rewrite a row that does not exist");
	});

	it("refuses a --section that names no heading, and points at the live list", async () => {
		const out = await run(populated(), {section: "Nowhere"});
		expect(out.code).toBe(SECTION_ABSENT);
		expect(out.stderr.at(-1)).toBe(
			`glossary add: "Nowhere" is not a section of ${DIR}/TERMS.md — run "fabrika glossary sections" for the live list.`,
		);
	});

	it("appends exactly five lines under --create-section, and reorders nothing", async () => {
		const io = populated();
		const out = await run(io, {section: "fabrika skill nouns", createSection: true});
		expect(out.stdout).toBe(`added\t${DIR}/TERMS.md\tfabrika skill nouns\t29\n`);
		const after = (io.written.get(TERMS_PATH) ?? "").split("\n");
		expect(after.slice(0, 24)).toEqual(TERMS.split("\n").slice(0, 24));
		expect(after.slice(24, 29)).toEqual([
			"",
			"## fabrika skill nouns",
			"| Term | Definition | Not |",
			"|---|---|---|",
			"| capture ledger | The append-only record of one capture run. | |",
		]);
	});

	it("refuses a definition that is empty after normalization", async () => {
		const out = await run(populated(), {stdin: piped("  \n ")});
		expect(out.code).toBe(EMPTY_STDIN);
	});

	it("refuses a definition file that is empty after normalization", async () => {
		const io = fakeFs({files: {[TERMS_PATH]: TERMS, "/repo/def.txt": "   \n"}});
		const out = await run(io, {definitionFile: "def.txt"});
		expect(out.code).toBe(ROW_SHAPE_INVALID);
		expect(out.stderr.at(-1)).toBe(
			"glossary add: the definition is empty after normalization — refusing to write a blank row.",
		);
	});

	it("refuses stdin that held nothing", async () => {
		const out = await run(populated(), {
			stdin: Effect.succeed({_tag: "NoStdin" as const, reason: "fd 0 is a TTY"}),
		});
		expect(out.code).toBe(EMPTY_STDIN);
		expect(out.stderr.at(-1)).toBe("glossary add: stdin held nothing.");
	});

	it("refuses a stdin READ that failed as UNKNOWN, never as empty", async () => {
		const out = await run(populated(), {
			stdin: Effect.succeed({_tag: "Failed" as const, reason: "EAGAIN"}),
		});
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses --register both — a term belongs to one register", async () => {
		const out = await run(populated(), {register: "both"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"glossary add: --register both is not writable — a term belongs to one register.",
		);
	});

	it("refuses an absent register and names the verb that creates one", async () => {
		const out = await run(fakeFs({files: {}}));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("fabrika glossary init");
	});

	it("reports a failed write as UNKNOWN, and writes nothing", async () => {
		const io = fakeFs({files: {[TERMS_PATH]: TERMS}, unwritable: [TERMS_PATH]});
		const out = await run(io);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(io.written.size).toBe(0);
	});

	it("emits the edit record as JSON", async () => {
		const out = await run(populated(), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			action: "added",
			path: `${DIR}/TERMS.md`,
			section: "Products (domains)",
			line: 16,
			term: "capture ledger",
			normalized: "capture ledger",
		});
	});

	it("names an unsorted section on stderr and still places the row against its neighbours", async () => {
		const unsorted = `## Products (domains)

| Term | Definition | Not |
|---|---|---|
| sozluk | x | |
| depo | y | |
`;
		const out = await run(fakeFs({files: {[TERMS_PATH]: unsorted}}));
		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("is not in ascending key order");
	});
});

/**
 * `15` is unreachable through the shipped composer, which only ever splices the lines it named —
 * `edit.unit.test.ts` proves the assertion itself catches a re-sort. Pinned here so the code is not
 * mistaken for dead: it is the guard that makes that property hold.
 */
describe("the one-row assertion", () => {
	it("is not reached by any ordinary add", async () => {
		const out = await run(populated());
		expect(out.code).not.toBe(EDIT_BEYOND_ROW);
	});
});
