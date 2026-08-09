import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFs, fakeFs} from "../fakes.test-support.ts";
import {NO_BILLED_TURNS, runRead, TRANSCRIPT_ABSENT, TRANSCRIPT_UNREADABLE} from "./read-verb.ts";
import {reconstructSpend} from "./token-spend.ts";

const PATH = "/runs/one-ruler.jsonl";

const fixture = readFileSync(
	fileURLToPath(new URL("./fixtures/one-ruler/transcript.jsonl", import.meta.url)),
	"utf8",
);

const assistantTurn = (usage: Record<string, number>, model = "claude-opus-5"): string =>
	JSON.stringify({message: {role: "assistant", model, usage}});

const run = (fs: FakeFs, json = false) =>
	Effect.runPromise(Effect.provide(runRead({transcript: PATH, json}), fs.layer));

const withText = (text: string | null) => fakeFs({files: {[PATH]: text}});

const rows = (stdout: string): Map<string, string> =>
	new Map(
		stdout
			.split("\n")
			.filter((line) => line !== "")
			.slice(1)
			.map((line) => line.split("\t") as [string, string]),
	);

describe("spend read — the answer", () => {
	it("names all eight components, with billed and the turn count on the header line", async () => {
		const out = await run(withText(fixture));
		const expected = reconstructSpend(fixture);

		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe(`spend\t${expected.billed}\t${expected.assistantTurns}`);
		expect(Object.fromEntries(rows(out.stdout))).toEqual({
			input: String(expected.input),
			cacheCreate: String(expected.cacheCreate),
			cacheRead: String(expected.cacheRead),
			output: String(expected.output),
			exCacheRead: String(expected.exCacheRead),
			model: expected.model,
		});
	});

	it("keeps the cache-read share visible rather than folded into the total", async () => {
		const out = await run(withText(fixture));
		const {cacheRead, billed} = reconstructSpend(fixture);

		expect(cacheRead).toBeGreaterThan(0);
		expect(rows(out.stdout).get("cacheRead")).toBe(String(cacheRead));
		expect(rows(out.stdout).get("exCacheRead")).toBe(String(billed - cacheRead));
	});

	it("emits the same eight fields as JSON on stdout under --json", async () => {
		const out = await run(withText(fixture), true);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual(reconstructSpend(fixture));
		expect(out.stderr.join("")).not.toContain('"billed"');
	});

	it("prints the scanned path and turn count on stderr, never on stdout", async () => {
		const out = await run(withText(fixture));

		expect(out.stderr.join("\n")).toContain(PATH);
		expect(out.stdout).not.toContain(PATH);
	});

	it("reports a run whose components are all zero but which billed a turn as a measured zero", async () => {
		const out = await run(withText(assistantTurn({input_tokens: 0, output_tokens: 0})));

		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("spend\t0\t1");
	});

	/** The no-gate ruling, asserted rather than noted: it fails the moment a threshold appears. */
	it("exits 0 on a very large total — no exit code varies with a spend magnitude", async () => {
		const out = await run(withText(assistantTurn({cache_read_input_tokens: 7_489_969_208})));

		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("spend\t7489969208\t1");
	});
});

describe("spend read — the refusals", () => {
	it("refuses a transcript that is provably not there, with empty stdout", async () => {
		const out = await run(fakeFs({files: {}}));

		expect(out.code).toBe(TRANSCRIPT_ABSENT);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain(PATH);
	});

	it("refuses an unreadable transcript as UNKNOWN, never as absent and never as a zero", async () => {
		const out = await run(fakeFs({files: {[PATH]: null}, unprobeable: [PATH]}));

		expect(out.code).toBe(TRANSCRIPT_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("seats both unreadable states above the reserved codes, distinct from each other", () => {
		expect(TRANSCRIPT_ABSENT).toBeGreaterThanOrEqual(3);
		expect(TRANSCRIPT_UNREADABLE).toBeGreaterThanOrEqual(3);
		expect(new Set([TRANSCRIPT_ABSENT, TRANSCRIPT_UNREADABLE, NO_BILLED_TURNS]).size).toBe(3);
	});

	it("refuses a transcript with zero billed assistant turns as its own state", async () => {
		const out = await run(withText('{"type":"summary"}'));

		expect(out.code).toBe(NO_BILLED_TURNS);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("zero billed assistant turns");
	});

	it("refuses an empty transcript the same way — read in full, nothing billed", async () => {
		const out = await run(withText(""));

		expect(out.code).toBe(NO_BILLED_TURNS);
		expect(out.stdout).toBe("");
	});

	it("refuses under --json too — a refusal never puts a payload on stdout", async () => {
		const out = await run(withText('{"type":"summary"}'), true);

		expect(out.code).toBe(NO_BILLED_TURNS);
		expect(out.stdout).toBe("");
	});
});
