/**
 * `guard decisions-index validate`'s IO boundary and exit taxonomy, over a scripted filesystem.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runDecisionsIndexGuard} from "./decisions-number-verb.ts";

const ROOT = "/repo";
const DIR = `${ROOT}/.decisions`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runDecisionsIndexGuard({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

const body = (id: string) =>
	`---\nid: ${id}\ntitle: A title\nstatus: accepted\ndate: 2026-08-18\n---\n\nbody\n`;

const corpus = (records: Readonly<Record<string, string>>): FakeFsOptions => ({
	directories: [DIR],
	dirs: {[DIR]: Object.keys(records)},
	files: Object.fromEntries(Object.entries(records).map(([n, t]) => [`${DIR}/${n}`, t])),
});

describe("runDecisionsIndexGuard", () => {
	it("passes a corpus with no collision or mismatch", async () => {
		const outcome = await run(corpus({"0001-a.md": body("0001"), "0002-b.md": body("0002")}));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("no duplicate id");
	});

	it("seats a duplicate id on the violation code with nothing on stdout", async () => {
		const outcome = await run(corpus({"0284-a.md": body("0284"), "0284-b.md": body("0284")}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("duplicate ADR id 0284");
	});

	// A duplicate is annotated on every colliding record: neither is the offender on its own.
	it("annotates each colliding record under Actions", async () => {
		const outcome = await run(corpus({"0284-a.md": body("0284"), "0284-b.md": body("0284")}), {
			GITHUB_ACTIONS: "true",
		});
		const errors = outcome.stderr.filter((l) => l.startsWith("::error"));
		expect(errors.some((l) => l.includes("file=.decisions/0284-a.md"))).toBe(true);
		expect(errors.some((l) => l.includes("file=.decisions/0284-b.md"))).toBe(true);
	});

	it("reds a filename/frontmatter number mismatch", async () => {
		const outcome = await run(corpus({"0284-a.md": body("0285")}));
		expect(outcome.code).toBe(VIOLATION);
	});

	// A name that leads with a digit and ends `.md` stays in scope even when malformed. v1's file
	// filter dropped such a name entirely, so a record whose NAME is broken could claim a taken
	// number and leave the guard's sight — the exact collision the lock exists to catch.
	it("catches a collision claimed by a malformed record name", async () => {
		const outcome = await run(corpus({"0284-a.md": body("0284"), "0284 -bad.md": body("0284")}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("0284 -bad.md");
	});

	it("ignores a non-record file beside the records", async () => {
		const outcome = await run(corpus({"0001-a.md": body("0001"), "README.md": "# not a record"}));
		expect(outcome.code).toBe(0);
	});

	it.each([
		["no .decisions directory", {} as FakeFsOptions],
		["an empty .decisions directory", corpus({})],
	])("fails closed with %s", async (_name, options) => {
		expect((await run(options)).code).toBe(ZERO_SCOPE);
	});

	it("is UNKNOWN when a record cannot be read", async () => {
		const outcome = await run({
			...corpus({"0001-a.md": body("0001")}),
			unreadable: [`${DIR}/0001-a.md`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
	});
});
