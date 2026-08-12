import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, record} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDigest} from "./digest-verb.ts";

const BASE_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736";
const LANDING = "1f8e83b1aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const PATH = ".decisions/0940-only-landed-adrs-may-be-cited.md";

const REMOTES = [/^git remote$/, okOut("origin\n")] as const;
const FETCH = [/^git fetch --quiet origin main$/, okOut("")] as const;
const RESOLVE = [
	/^git rev-parse --verify --quiet origin\/main\^\{commit\}$/,
	okOut(`${BASE_SHA}\n`),
] as const;
const SHALLOW = [/^git rev-parse --is-shallow-repository$/, okOut("false\n")] as const;
const TREE = [
	new RegExp(`^git ls-tree -r --name-only -z ${BASE_SHA}$`),
	okOut(`${PATH}\0.decisions/0238-fabrika-reimplements-v1.md\0src/cart.ts\0`),
] as const;
const LOG = [
	/^git log --reverse --format=%H%x09%cI /,
	okOut(`${LANDING}\t2026-08-08T09:12:00Z\n`),
] as const;
const STATUSES = [
	new RegExp(`^git show .* --name-status -z --format= ${LANDING} -- \\.decisions$`),
	okOut(`A\0${PATH}\0`),
] as const;
const COMMIT_DIFF = [
	new RegExp(`^git show .*--format= ${LANDING}$`),
	okOut(
		`diff --git a/skills/x.md b/skills/x.md\n--- a/skills/x.md\n+++ b/skills/x.md\n@@ -1,2 +1,2 @@\n-<!-- anchor: G --> one\n+<!-- anchor: G --> two\n`,
	),
] as const;
const SHOW = [
	new RegExp(`^git show ${LANDING}:\\.decisions/0940`),
	okOut(record("0940", "accepted")),
] as const;

const options = {
	since: "2026-08-02",
	until: null as string | null,
	dir: ".decisions",
	base: "origin/main",
	json: false,
	now: Effect.succeed(Date.parse("2026-08-10T00:00:00Z")),
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runDigest({...options, ...overrides}), fakeShell(script).layer));

const happy: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	REMOTES,
	FETCH,
	RESOLVE,
	SHALLOW,
	TREE,
	LOG,
	STATUSES,
	COMMIT_DIFF,
	SHOW,
];

describe("runDigest", () => {
	it("lists each landing with its status as written, commit, date and anchor delta", async () => {
		const out = await run(happy);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe(
			[
				"digest\tlanded\t1",
				"landed\t0940\taccepted\t1f8e83b1\t2026-08-08\t1\tA decision about 0940",
				"",
			].join("\n"),
		);
	});

	it("reports `status:` verbatim rather than interpreting it (#4388)", async () => {
		const out = await run([...happy.slice(0, 8), [SHOW[0], okOut(record("0940", "proposed"))]]);
		expect(out.stdout).toContain("\tproposed\t");
	});

	it("answers `none` at exit 0 over a walked window that carried nothing", async () => {
		const out = await run([REMOTES, FETCH, RESOLVE, SHALLOW, TREE, [LOG[0], okOut("")]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("digest\tnone\t0\n");
	});

	it("emits the record with --json, naming the window it walked", async () => {
		const out = await run(happy, {json: true, until: "2026-08-09"});
		expect(JSON.parse(out.stdout)).toMatchObject({
			outcome: "landed",
			count: 1,
			window: {since: "2026-08-02", until: "2026-08-09"},
			base: "origin/main",
		});
	});

	it("states the base, the window and the commit count on stderr", async () => {
		const out = await run(happy, {until: "2026-08-09"});
		expect(out.stderr.at(-1)).toBe(
			"governance digest: walked origin/main from 2026-08-02 to 2026-08-09, 1 commits touching .decisions.",
		);
	});

	it("FETCHES the base before it walks it — a stale checkout applies withdrawn doctrine", async () => {
		const fake = fakeShell(happy);
		await Effect.runPromise(Effect.provide(runDigest(options), fake.layer));
		const fetched = fake.calls.indexOf("git fetch --quiet origin main");
		const walked = fake.calls.findIndex((call) => call.startsWith("git log --reverse"));
		expect(fetched).toBeGreaterThanOrEqual(0);
		expect(fetched).toBeLessThan(walked);
	});

	it("refuses a malformed date, and a window that runs backwards, on 10", async () => {
		expect((await run(happy, {since: "08/02/2026"})).code).toBe(OFF_VOCABULARY);
		expect((await run(happy, {until: "2026-08-01"})).code).toBe(OFF_VOCABULARY);
	});

	it("refuses an unfetchable base on 11 — what landed is UNKNOWN, never `none`", async () => {
		const out = await run([REMOTES, [FETCH[0], errOut("fatal: could not read from remote")]]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('what landed is UNKNOWN, never "none"');
	});

	it("refuses a corpus with zero records on 7", async () => {
		const out = await run([REMOTES, FETCH, RESOLVE, SHALLOW, [TREE[0], okOut("src/cart.ts\0")]]);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stderr.at(-1)).toBe(
			"governance digest: scanned .decisions, 0 decision records — refusing to answer (ADR 0092).",
		);
	});

	it("refuses a shallow clone whose boundary falls inside the window on 13", async () => {
		const out = await run([
			REMOTES,
			FETCH,
			RESOLVE,
			[SHALLOW[0], okOut("true\n")],
			[/^git log --max-parents=0 /, okOut("2026-08-05T00:00:00Z\n")],
		]);
		expect(out.code).toBe(INCOMPLETE_SCAN);
		expect(out.stderr.at(-1)).toContain("refusing a partial landing list");
	});

	it("walks a shallow clone whose boundary predates the window", async () => {
		const out = await run([
			REMOTES,
			FETCH,
			RESOLVE,
			[SHALLOW[0], okOut("true\n")],
			[/^git log --max-parents=0 /, okOut("2026-01-01T00:00:00Z\n")],
			TREE,
			LOG,
			STATUSES,
			COMMIT_DIFF,
			SHOW,
		]);
		expect(out.code).toBe(0);
	});

	it("refuses an unreadable landing commit on 11 rather than dropping it from the window", async () => {
		const out = await run([
			REMOTES,
			FETCH,
			RESOLVE,
			SHALLOW,
			TREE,
			LOG,
			[STATUSES[0], errOut("fatal: bad object")],
		]);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stderr.at(-1)).toContain("the window is UNKNOWN");
	});
});
