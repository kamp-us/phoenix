import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut} from "../fakes.test-support.ts";
import {NO_TARGET, QUEUE_UNREADABLE, SEARCH_UNREADABLE} from "./codes.ts";
import {runDedup} from "./dedup-verb.ts";

const LABELS = /repos\/o\/r\/labels/;
const QUEUE = /repos\/o\/r\/issues\?state=open/;
const SEARCH = /search\/issues/;

const options = {
	query: "retry helper swallows the abort reason",
	label: "status:needs-triage",
	limit: 20,
	repo: null,
	json: false,
	exclude: null as number | null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(Effect.provide(runDedup({...options, ...overrides}), fakeShell(script).layer));

const labelsOk = [LABELS, okOut("status:needs-triage\ntype:bug\np0")] as const;

describe("runDedup", () => {
	it("exits 0 with a ranked candidates list", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, okOut("4312\tAbort reason lost when the retry helper re-wraps the request")],
			[SEARCH, okOut("4088\thttp worker retries do not propagate cancellation")],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("candidates");
		expect(out.stdout).toContain("4312\tqueue\t");
		expect(out.stdout).toContain("4088\tsearch\t");
	});

	it("--exclude drops the issue being deduped from both sources, so it cannot flag itself", async () => {
		const title = "Abort reason lost when the retry helper re-wraps the request";
		const out = await run(
			[labelsOk, [QUEUE, okOut(`4312\t${title}`)], [SEARCH, okOut(`4312\t${title}`)]],
			{exclude: 4312},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("none\n");
		expect(out.stderr.join("\n")).toContain("#4312 excluded from both sources");
	});

	it("says nothing about exclusion on the scope line when --exclude was not given", async () => {
		const out = await run([labelsOk, [QUEUE, okOut("")], [SEARCH, okOut("")]]);
		expect(out.stderr.join("\n")).not.toContain("excluded from both sources");
	});

	it("exits 0 on a PROVEN none, printing the token rather than empty stdout", async () => {
		const out = await run([labelsOk, [QUEUE, okOut("")], [SEARCH, okOut("")]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("none\n");
		expect(out.stderr.join("\n")).toContain("both sources were read");
	});

	it("exits 0 on indeterminate below the two-token floor", async () => {
		const out = await run([labelsOk], {query: "the thing"});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("indeterminate\n");
		expect(out.stderr.join("\n")).toContain("below the floor of 2");
	});

	it("REFUSES a --label that does not exist rather than printing `none` over zero scope (#4752)", async () => {
		const out = await run([[LABELS, okOut("type:bug\np0")]]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "none"');
	});

	it("never reads either source once the label is proven absent", async () => {
		const shell = fakeShell([[LABELS, okOut("type:bug")]]);
		await Effect.runPromise(Effect.provide(runDedup(options), shell.layer));
		expect(shell.calls.some((c) => QUEUE.test(c) || SEARCH.test(c))).toBe(false);
	});

	it("refuses an UNREADABLE label set as UNKNOWN — never as `the label is missing`", async () => {
		const out = await run([[LABELS, errOut("gh: Bad gateway (HTTP 502)")]]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses an unreadable queue — UNKNOWN, never `none`", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, errOut("gh: Not Found (HTTP 404)")],
			[SEARCH, okOut("")],
		]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "none"');
	});

	it("refuses an unreadable search index on its own code", async () => {
		const out = await run([labelsOk, [QUEUE, okOut("")], [SEARCH, errOut("rate limited")]]);
		expect(out.code).toBe(SEARCH_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("reports the QUEUE's code when both fail, and names both failures", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, errOut("queue down")],
			[SEARCH, errOut("search down")],
		]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stderr.at(-1)).toContain("queue down");
		expect(out.stderr.at(-1)).toContain("search down");
	});

	it("refuses a `gh` that exited 0 with output that is not issue rows", async () => {
		const out = await run([labelsOk, [QUEUE, okOut("not a row")], [SEARCH, okOut("")]]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("puts the --json payload on STDOUT, with both source counts", async () => {
		const out = await run(
			[labelsOk, [QUEUE, okOut("4312\tretry helper abort reason")], [SEARCH, okOut("")]],
			{json: true},
		);
		const payload = JSON.parse(out.stdout);
		expect(payload.outcome).toBe("candidates");
		expect(payload.queueCount).toBe(1);
		expect(payload.searchCount).toBe(0);
		expect(payload.tokens).toContain("retry");
		expect(out.stderr.join("")).not.toContain('"outcome"');
	});

	it("says on stderr when the cap truncated the list", async () => {
		const rows = Array.from({length: 4}, (_, i) => `${i + 1}\tretry helper abort reason`).join(
			"\n",
		);
		const out = await run([labelsOk, [QUEUE, okOut(rows)], [SEARCH, okOut("")]], {limit: 2});
		expect(out.stdout.split("\n").filter((l) => l !== "")).toHaveLength(3);
		expect(out.stderr[0]).toContain("TRUNCATED");
	});

	it("refuses an empty --query as a usage error", async () => {
		const out = await run([labelsOk], {query: "   "});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("refuses when no target repo resolves", async () => {
		const out = await run([[/git remote get-url/, errOut("no origin")]], {env: {}});
		expect(out.code).toBe(1);
		expect(out.stderr.at(-1)).toContain("CLAUDE_PIPELINE_REPO");
	});
});
