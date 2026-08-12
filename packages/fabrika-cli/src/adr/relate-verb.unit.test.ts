import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {ALREADY_SUPERSEDED, MULTI_LINE_DIFF, NO_BY, NO_STATUS_LINE, NO_SUBJECT} from "./codes.ts";
import {type RelateOptions, runRelate} from "./relate-verb.ts";

const rec = (id: string, status: string): string =>
	`---\nid: ${id}\ntitle: Title ${id}\nstatus: ${status}\ndate: 2026-01-01\ntags: []\n---\n\n# ${id} — Title ${id}\n\n## Decision\n\n**A thing.**\n`;

const THREE_LINKS =
	"amended-in-part by [0025](0025-split-livedo-connection-topic.md), [0028](0028-effect-durable-object-model.md), [0037](0037-unified-void-aligned-live-do.md)";

const dir = ".decisions";
const files = {
	[`${dir}/0126-ambient-adr-discovery.md`]: rec("0126", "accepted"),
	[`${dir}/0023-live-views-sse-livedo.md`]: rec("0023", THREE_LINKS),
	[`${dir}/0940-only-landed-adrs-may-be-cited.md`]: rec("0940", "accepted"),
};
const dirs = {[dir]: Object.keys(files).map((p) => p.slice(dir.length + 1))};

const fs = () => fakeFs({dirs, files});

const supersede = {relationship: "supersede", dir, json: false} as const;
const amend = {relationship: "amend-in-part", dir, json: false} as const;

const run = (io: FakeFs, options: RelateOptions) =>
	Effect.runPromise(Effect.provide(runRelate(options), io.layer));

describe("runRelate — supersede", () => {
	it("rewrites the status line and prints path + new status", async () => {
		const io = fs();
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			".decisions/0126-ambient-adr-discovery.md\tsuperseded by [0940](0940-only-landed-adrs-may-be-cited.md)\n",
		);
		expect(io.written.get(`${dir}/0126-ambient-adr-discovery.md`)).toContain(
			"status: superseded by [0940](0940-only-landed-adrs-may-be-cited.md)",
		);
	});

	it("resolves --by's slug off disk, never from a guessed title", async () => {
		const out = await run(fs(), {...supersede, id: "0126", by: "0940"});
		expect(out.stdout).toContain("(0940-only-landed-adrs-may-be-cited.md)");
	});

	it("refuses when <id> has no record", async () => {
		const out = await run(fs(), {...supersede, id: "9998", by: "0940"});
		expect(out.code).toBe(NO_SUBJECT);
		expect(out.stderr.at(-1)).toBe("adr supersede: no record for id 9998 under .decisions.");
	});

	it("refuses a dead --by link and writes nothing", async () => {
		const io = fs();
		const out = await run(io, {...supersede, id: "0126", by: "9999"});
		expect(out.code).toBe(NO_BY);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"adr supersede: no record for --by id 9999 under .decisions — refusing to write a dead link.",
		);
		expect(io.written.size).toBe(0);
	});

	it("refuses a record with no single frontmatter status line", async () => {
		const io = fakeFs({
			dirs: {[dir]: ["0126-a.md", "0940-b.md"]},
			files: {
				[`${dir}/0126-a.md`]: "# no frontmatter\n",
				[`${dir}/0940-b.md`]: rec("0940", "accepted"),
			},
		});
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).toBe(NO_STATUS_LINE);
		expect(io.written.size).toBe(0);
	});

	it("refuses an unreadable subject rather than treating it as empty", async () => {
		const io = fakeFs({
			dirs: {[dir]: ["0126-a.md", "0940-b.md"]},
			files: {[`${dir}/0126-a.md`]: null, [`${dir}/0940-b.md`]: rec("0940", "accepted")},
		});
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).not.toBe(0);
		expect(out.stdout).toBe("");
		expect(io.written.size).toBe(0);
	});

	it("refuses an unreadable directory rather than reporting 'no record'... with a write", async () => {
		const io = fakeFs({dirs: {[dir]: null}});
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).toBe(NO_SUBJECT);
		expect(io.written.size).toBe(0);
	});

	it("refuses to re-supersede an already-superseded record", async () => {
		const io = fakeFs({
			dirs,
			files: {
				...files,
				[`${dir}/0126-ambient-adr-discovery.md`]: rec("0126", "superseded by [0100](0100-x.md)"),
			},
		});
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).toBe(ALREADY_SUPERSEDED);
		expect(out.stderr.at(-1)).toContain("not re-supersedable");
	});
});

describe("runRelate — amend-in-part", () => {
	it("APPENDS to an existing multi-link list, preserving every link already there", async () => {
		const io = fs();
		const out = await run(io, {...amend, id: "0023", by: "0940"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			`.decisions/0023-live-views-sse-livedo.md\t${THREE_LINKS}, [0940](0940-only-landed-adrs-may-be-cited.md)\n`,
		);
		const written = io.written.get(`${dir}/0023-live-views-sse-livedo.md`) ?? "";
		for (const id of ["0025", "0028", "0037", "0940"]) expect(written).toContain(`[${id}]`);
	});

	it("changes exactly one line of the file", async () => {
		const io = fs();
		await run(io, {...amend, id: "0023", by: "0940"});
		const before = (files[`${dir}/0023-live-views-sse-livedo.md`] ?? "").split("\n");
		const after = (io.written.get(`${dir}/0023-live-views-sse-livedo.md`) ?? "").split("\n");
		expect(after).toHaveLength(before.length);
		expect(before.filter((line, i) => line !== after[i])).toHaveLength(1);
	});

	it("re-adding the same link is a no-op that still exits 0", async () => {
		const io = fs();
		await run(io, {...amend, id: "0023", by: "0940"});
		const first = io.written.get(`${dir}/0023-live-views-sse-livedo.md`);
		const out = await run(io, {...amend, id: "0023", by: "0940"});
		expect(out.code).toBe(0);
		expect(io.written.get(`${dir}/0023-live-views-sse-livedo.md`)).toBe(first);
	});

	it("refuses to amend a superseded record", async () => {
		const io = fakeFs({
			dirs,
			files: {
				...files,
				[`${dir}/0023-live-views-sse-livedo.md`]: rec("0023", "superseded by [0100](0100-x.md)"),
			},
		});
		const out = await run(io, {...amend, id: "0023", by: "0940"});
		expect(out.code).toBe(ALREADY_SUPERSEDED);
		expect(out.stderr.at(-1)).toContain("not amendable");
		expect(io.written.size).toBe(0);
	});

	it("prefixes every message with the invoked verb name", async () => {
		const out = await run(fs(), {...amend, id: "9998", by: "0940"});
		expect(out.stderr.at(-1)?.startsWith("adr amend-in-part:")).toBe(true);
	});

	it("--json carries the before and after status", async () => {
		const out = await run(fs(), {...amend, id: "0126", by: "0940", json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			path: ".decisions/0126-ambient-adr-discovery.md",
			id: "0126",
			by: "0940",
			statusBefore: "accepted",
			statusAfter: "amended-in-part by [0940](0940-only-landed-adrs-may-be-cited.md)",
		});
	});
});

describe("exit 15 — the one-line-diff assertion, driven through the verb", () => {
	/**
	 * A record whose frontmatter is `\n`-terminated while its body is `\r\n`-terminated. The rewrite
	 * splits on `/\r?\n/` and re-joins with the one ending `\r\n` it sees in the text, so every
	 * frontmatter line's terminator would change — lines this verb has no licence to touch.
	 */
	const mixed = "---\nid: 0126\ntitle: T\nstatus: accepted\n---\n\r\n# 0126 — T\r\n";

	it("refuses a rewrite that would normalise other lines' endings, and writes NOTHING", async () => {
		const io = fakeFs({
			dirs: {[dir]: ["0126-a.md", "0940-b.md"]},
			files: {[`${dir}/0126-a.md`]: mixed, [`${dir}/0940-b.md`]: rec("0940", "accepted")},
		});
		const out = await run(io, {...supersede, id: "0126", by: "0940"});
		expect(out.code).toBe(MULTI_LINE_DIFF);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("line(s) beyond status:");
		expect(io.written.size).toBe(0);
	});
});

describe("the exit codes are the contract's", () => {
	it("seats every proven refusal on 3+, never on 1 or 127", () => {
		const codes = [NO_SUBJECT, NO_BY, NO_STATUS_LINE, MULTI_LINE_DIFF, ALREADY_SUPERSEDED];
		for (const code of codes) expect(code).toBeGreaterThanOrEqual(3);
		expect(new Set(codes).size).toBe(codes.length);
	});
});
