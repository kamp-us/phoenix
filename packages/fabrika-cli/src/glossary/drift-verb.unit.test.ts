import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, type FakeFs, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {runDrift} from "./drift-verb.ts";
import {DIR, LANGUAGE_NO_ROWS, REPO, TERMS, TERMS_PATH} from "./fixtures.test-support.ts";

const FIELD = "\u001f";
const RECORD = "\u001e";

const commit = (sha: string, subject: string, body = "") =>
	`${sha}${FIELD}${subject}${FIELD}${body}${RECORD}`;

const options = {register: "terms", dir: DIR, paths: "", limit: 40, json: false, cwd: REPO};

const shell = (
	log: string,
	extra: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = [],
) =>
	fakeShell([
		[/git log -n 1 --format=%H %ct/, okOut("abc1234 1700000000\n")],
		[/git ls-files/, okOut("apps/web/src/index.ts\n")],
		[/git show --name-only/, okOut("src/capture/ledger.ts\napps/web/x.ts\n")],
		[/git log --reverse/, okOut(log)],
		...extra,
	]);

const run = (
	fs: FakeFs,
	sh: ReturnType<typeof fakeShell>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runDrift({...options, ...overrides}), Layer.merge(fs.layer, sh.layer)),
	);

const populated = () =>
	fakeFs({dirs: {"/repo/.glossary": ["TERMS.md"]}, files: {[TERMS_PATH]: TERMS}});

describe("runDrift", () => {
	it("answers drift with one tab-separated line per candidate", async () => {
		const out = await run(populated(), shell(commit("aaa", 'add "capture ledger" to the worker')));
		expect(out.code).toBe(0);
		const lines = out.stdout.split("\n").filter((line) => line !== "");
		expect(lines[0]).toBe("drift");
		expect(lines).toContain("capture ledger\t1\tsrc/capture/ledger.ts");
	});

	it("suppresses a candidate whose normalized key is already declared", async () => {
		const out = await run(populated(), shell(commit("aaa", 'add "depo" and "pano"')));
		expect(out.stdout.split("\n")[0]).toBe("clean");
	});

	it("answers clean with the pinned reason, so `no drift` is not silence", async () => {
		const out = await run(populated(), shell(""));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("clean\n");
		expect(out.stderr.at(-1)).toBe(
			"glossary drift: swept 0 commit(s) since abc1234; every candidate was already declared — this is a clean sweep, not an unread range.",
		);
	});

	it("answers bootstrap for a --dir that was read and holds no register", async () => {
		const out = await run(fakeFs({dirs: {"/repo/.glossary": []}, files: {}}), shell(""));
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("bootstrap\n");
		expect(out.stderr.at(-1)).toContain("which is bootstrap, not empty drift");
	});

	it("answers bootstrap for a register that parses to zero rows", async () => {
		const io = fakeFs({
			dirs: {"/repo/.glossary": ["TERMS.md"]},
			files: {[TERMS_PATH]: LANGUAGE_NO_ROWS},
		});
		const out = await run(io, shell(""));
		expect(out.stdout).toBe("bootstrap\n");
		expect(out.stderr.at(-1)).toContain("parsed to 0 rows — bootstrap, not empty drift");
	});

	// v1 defaulted the pathspec to a literal `apps packages`, so a repo with another layout got a
	// permanently empty diff that read as "no drift" (#4776). A pathspec matching nothing is a red.
	it("reds on a --paths that matched 0 tracked files, rather than reporting clean", async () => {
		const out = await run(
			populated(),
			fakeShell([
				[/git ls-files/, okOut("")],
				[/git log -n 1/, okOut("abc1234 1700000000\n")],
			]),
			{paths: "no/such/dir"},
		);
		expect(out.code).toBe(ZERO_SCOPE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toBe(
			"glossary drift: --paths no/such/dir matched 0 tracked files — refusing to report a clean sweep of nothing (ADR 0092).",
		);
	});

	it("refuses an unreadable --dir — the declared set is UNKNOWN, never `0 declared`", async () => {
		const out = await run(fakeFs({dirs: {}, files: {}, unprobeable: [TERMS_PATH]}), shell(""));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "0 declared"');
	});

	/**
	 * v1 captured the last commit without checking the status, then read an empty capture as "never
	 * committed" and reported bootstrap — which a shallow clone reproduces on a register that IS
	 * committed. An unresolvable range is UNKNOWN here.
	 */
	it("refuses an unresolvable range rather than calling it never committed", async () => {
		const out = await run(
			populated(),
			fakeShell([
				[/git log -n 1/, okOut("")],
				[/git ls-files/, okOut("x\n")],
			]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "never committed"');
	});

	it("refuses a commit-range read that failed", async () => {
		const out = await run(
			populated(),
			fakeShell([
				[/git log -n 1/, okOut("abc1234 1700000000\n")],
				[/git log --reverse/, errOut("fatal: bad revision")],
			]),
		);
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses an off-enum --register", async () => {
		const out = await run(populated(), shell(""), {register: "sozluk"});
		expect(out.code).toBe(OFF_VOCABULARY);
	});

	it("carries the counts the outcome is only readable against, in --json", async () => {
		const out = await run(populated(), shell(""), {json: true});
		expect(JSON.parse(out.stdout)).toEqual({
			outcome: "clean",
			candidates: [],
			reason:
				"swept 0 commit(s) since abc1234; every candidate was already declared — this is a clean sweep, not an unread range",
			sinceCommit: "abc1234",
			scannedCommits: 0,
			declaredKeys: 5,
		});
	});

	it("counts distinct KEYS rather than rows, so a planted duplicate collapses", async () => {
		const out = await run(populated(), shell(""), {json: true});
		// The fixture's six rows carry five distinct keys — `pano` is declared twice.
		expect(JSON.parse(out.stdout).declaredKeys).toBe(5);
	});

	it("honours --limit", async () => {
		const out = await run(
			populated(),
			shell(commit("aaa", "add capture ledger rotation policy today")),
			{limit: 2},
		);
		expect(out.stdout.split("\n").filter((line) => line !== "")).toHaveLength(3);
	});
});
