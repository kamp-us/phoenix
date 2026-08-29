import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {NO_TARGET, QUEUE_UNREADABLE, SEARCH_UNREADABLE} from "./codes.ts";
import {runDedup} from "./dedup-verb.ts";

const LABELS = /repos\/o\/r\/labels/;
const QUEUE = /repos\/o\/r\/issues\?state=open/;
const SEARCH = /search\/issues/;

/** A label-set page: the endpoint answers `[{name}]`, not one name per line. */
const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const issueRows = (...rows: ReadonlyArray<readonly [number, string]>): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows.map(([number, title]) => ({number, title}))),
});

/** The search index answers a `{total_count, items}` envelope. */
const searchHits = (...rows: ReadonlyArray<readonly [number, string]>): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		total_count: rows.length,
		items: rows.map(([number, title]) => ({number, title})),
	}),
});

const options = {
	query: "retry helper swallows the abort reason",
	label: "status:needs-triage",
	limit: 20,
	repo: null,
	json: false,
	exclude: null as number | null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(Effect.provide(runDedup({...options, ...overrides}), fakeSeams(script).layer));

const labelsOk = [LABELS, labelSet("status:needs-triage", "type:bug", "p0")] as const;

/** #7213's reported query, whose twelve AND-joined terms matched nothing. */
const LONG_QUERY =
	"review render seed authenticated notification rows state suffix reserved unimplemented exit capture";

const searchQuery = (requests: ReadonlyArray<string>): string =>
	decodeURIComponent(requests.find((call) => SEARCH.test(call)) ?? "");

describe("runDedup", () => {
	it("exits 0 with a ranked candidates list", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, issueRows([4312, "Abort reason lost when the retry helper re-wraps the request"])],
			[SEARCH, searchHits([4088, "http worker retries do not propagate cancellation"])],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("candidates");
		expect(out.stdout).toContain("4312\tqueue\t");
		expect(out.stdout).toContain("4088\tsearch\t");
	});

	it("--exclude drops the issue being deduped from both sources, so it cannot flag itself", async () => {
		const title = "Abort reason lost when the retry helper re-wraps the request";
		const out = await run(
			[labelsOk, [QUEUE, issueRows([4312, title])], [SEARCH, searchHits([4312, title])]],
			{exclude: 4312},
		);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("none\n");
		expect(out.stderr.join("\n")).toContain("#4312 excluded from both sources");
	});

	it("says nothing about exclusion on the scope line when --exclude was not given", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]]);
		expect(out.stderr.join("\n")).not.toContain("excluded from both sources");
	});

	it("exits 0 on a PROVEN none, printing the token rather than empty stdout", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]]);
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
		const out = await run([[LABELS, labelSet("type:bug", "p0")]]);
		expect(out.code).toBe(NO_TARGET);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "none"');
	});

	it("never reads either source once the label is proven absent", async () => {
		const seams = fakeSeams([[LABELS, labelSet("type:bug")]]);
		await Effect.runPromise(Effect.provide(runDedup(options), seams.layer));
		expect(seams.requests.some((c) => QUEUE.test(c) || SEARCH.test(c))).toBe(false);
	});

	it("refuses an UNREADABLE label set as UNKNOWN — never as `the label is missing`", async () => {
		const out = await run([[LABELS, {status: 502, body: "{}"}]]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain("UNKNOWN");
	});

	it("refuses an unreadable queue — UNKNOWN, never `none`", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, {status: 404, body: '{"message":"Not Found"}'}],
			[SEARCH, searchHits()],
		]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.at(-1)).toContain('never "none"');
	});

	it("refuses an unreadable search index on its own code", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, issueRows()],
			[SEARCH, {status: 429, body: '{"message":"rate limited"}'}],
		]);
		expect(out.code).toBe(SEARCH_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("reports the QUEUE's code when both fail, and names both failures", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, {status: 503, body: "{}"}],
			[SEARCH, {status: 429, body: "{}"}],
		]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stderr.at(-1)).toContain("HTTP 503");
		expect(out.stderr.at(-1)).toContain("HTTP 429");
	});

	it("refuses a 200 whose body is not a list of issues", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, {status: 200, body: JSON.stringify([{title: "no number"}])}],
			[SEARCH, searchHits()],
		]);
		expect(out.code).toBe(QUEUE_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it("puts the --json payload on STDOUT, with both source counts", async () => {
		const out = await run(
			[labelsOk, [QUEUE, issueRows([4312, "retry helper abort reason"])], [SEARCH, searchHits()]],
			{json: true},
		);
		const payload = JSON.parse(out.stdout);
		expect(payload.outcome).toBe("candidates");
		expect(payload.queueCount).toBe(1);
		expect(payload.searchCount).toBe(0);
		expect(payload.tokens).toContain("retry");
		expect(out.stderr.join("")).not.toContain('"outcome"');
	});

	it("sends ONLY the leading slice to the AND-joined search query (#7213)", async () => {
		const seams = fakeSeams([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]]);
		await Effect.runPromise(Effect.provide(runDedup({...options, query: LONG_QUERY}), seams.layer));
		const sent = searchQuery(seams.requests);
		expect(sent).toContain("is:open review render seed authenticated");
		expect(sent).not.toContain("notification");
	});

	it("still ranks against the FULL token list, so narrowing does not blunt scoring", async () => {
		const out = await run(
			[labelsOk, [QUEUE, issueRows([4312, LONG_QUERY])], [SEARCH, searchHits()]],
			{query: LONG_QUERY},
		);
		expect(out.stdout).toContain("4312\tqueue\t12\t");
	});

	it("retrieves a search row an over-long AND-join would have lost", async () => {
		// Scripted to answer only the NARROWED query: a twelve-term send falls through to the
		// unscripted 500 and refuses, so the row can only be reached by the slice.
		const narrowOnly = /search\/issues\?q=[^"]*authenticated(?!.*notification)/;
		const out = await run(
			[
				labelsOk,
				[QUEUE, issueRows()],
				[
					narrowOnly,
					searchHits([7051, "review-ui default-state captures leave interaction states unjudged"]),
				],
			],
			{query: LONG_QUERY},
		);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("candidates");
		expect(out.stdout).toContain("7051\tsearch\t");
	});

	it("names the tokens actually SENT to search on the scope line when they differ", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]], {
			query: LONG_QUERY,
		});
		expect(out.stderr[0]).toContain("sent to search: review, render, seed, authenticated");
	});

	it("says nothing about a narrowed send when the whole list went to search", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]], {
			query: "retry helper abort reason",
		});
		expect(out.stderr[0]).not.toContain("sent to search");
	});

	it("--json carries the two lists apart", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]], {
			query: LONG_QUERY,
			json: true,
		});
		const payload = JSON.parse(out.stdout);
		expect(payload.tokens).toHaveLength(12);
		expect(payload.searchTokens).toEqual(["review", "render", "seed", "authenticated"]);
	});

	it("evaluates the indeterminate floor against the RANKING list, never the narrowed slice", async () => {
		const out = await run([labelsOk, [QUEUE, issueRows()], [SEARCH, searchHits()]], {
			query: LONG_QUERY,
		});
		expect(out.stdout.split("\n")[0]).toBe("none");
	});

	it("says on stderr when the cap truncated the list", async () => {
		const rows = Array.from({length: 4}, (_, i) => [i + 1, "retry helper abort reason"] as const);
		const out = await run([labelsOk, [QUEUE, issueRows(...rows)], [SEARCH, searchHits()]], {
			limit: 2,
		});
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
