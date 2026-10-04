import {NodeCrypto} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {NO_TARGET, QUEUE_UNREADABLE, SEARCH_UNREADABLE} from "./codes.ts";
import {runDedup} from "./dedup-verb.ts";
import {IndexSnapshot} from "./index-cache.ts";

const LABELS = /repos\/o\/r\/labels/;
const QUEUE = /repos\/o\/r\/issues\?state=open&labels=/;
const SEARCH = /repos\/o\/r\/issues\?state=open&sort=/;

/** A label-set page: the endpoint answers `[{name}]`, not one name per line. */
const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

const issueRows = (...rows: ReadonlyArray<readonly [number, string]>): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map(([number, title]) => ({number, title, body: "", state: "open", closed_at: null})),
	),
});

const searchHits = issueRows;

const options = {
	query: "retry helper swallows the abort reason",
	closedDays: 0,
	label: "status:needs-triage",
	limit: 20,
	repo: null,
	json: false,
	exclude: null as number | null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) =>
	Effect.runPromise(
		Effect.provide(
			runDedup({...options, ...overrides}),
			Layer.mergeAll(fakeSeams(script).layer, fakeFs({}).layer, NodeCrypto.layer),
		),
	);

const labelsOk = [LABELS, labelSet("status:needs-triage", "type:bug", "p0")] as const;

/** The reported query whose twelve AND-joined terms matched nothing. */
const LONG_QUERY =
	"review render seed authenticated notification rows state suffix reserved unimplemented exit capture";

describe("runDedup", () => {
	it("exits 0 with a ranked candidates list", async () => {
		const out = await run([
			labelsOk,
			[QUEUE, issueRows([4312, "Abort reason lost when the retry helper re-wraps the request"])],
			[SEARCH, searchHits([4088, "retry worker does not propagate cancellation"])],
		]);
		expect(out.code).toBe(0);
		expect(out.stdout.split("\n")[0]).toBe("candidates");
		expect(out.stdout).toContain("4312\tqueue\t");
		expect(out.stdout).toContain("4088\tindex\t");
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
		expect(out.stderr.join("\n")).toContain("no lexical matches");
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
		await Effect.runPromise(
			Effect.provide(
				runDedup(options),
				Layer.mergeAll(seams.layer, fakeFs({}).layer, NodeCrypto.layer),
			),
		);
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
		expect(payload.indexCount).toBe(0);
		expect(payload.tokens).toContain("retry");
		expect(out.stderr.join("")).not.toContain('"outcome"');
	});

	it("finds a body-only match despite misleading leading words, without GitHub search", async () => {
		const seams = fakeSeams([
			labelsOk,
			[QUEUE, issueRows()],
			[
				SEARCH,
				{
					status: 200,
					body: JSON.stringify([
						{
							number: 7051,
							title: "Interaction coverage",
							body: "notification state capture",
							state: "open",
							closed_at: null,
						},
					]),
				},
			],
		]);
		const out = await Effect.runPromise(
			Effect.provide(
				runDedup({...options, query: LONG_QUERY, json: true}),
				Layer.mergeAll(seams.layer, fakeFs({}).layer, NodeCrypto.layer),
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout).candidates[0].number).toBe(7051);
		expect(seams.requests.some((call) => call.includes("search/issues"))).toBe(false);
	});

	it("reports closed state and the actual window in JSON and lines", async () => {
		const closed = {
			number: 42,
			title: "retry helper",
			body: "",
			state: "closed",
			closed_at: new Date().toISOString(),
		};
		const script = [
			labelsOk,
			[QUEUE, issueRows()],
			[SEARCH, issueRows()],
			[/state=closed/, {status: 200, body: JSON.stringify([closed])}],
		] as const;
		const json = await run(script, {closedDays: 14, json: true});
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toMatchObject({
			candidates: [{number: 42, state: "closed"}],
			cache: {source: "fetched", ageMs: 0},
			indexCount: 1,
		});
		expect(JSON.parse(json.stdout).closedSince).toMatch(/^\d{4}-/);
		const line = await run(script, {closedDays: 14});
		expect(line.stdout).toContain("\tclosed\tretry helper");
	});

	it("refuses an unreadable closed source rather than publishing a partial index", async () => {
		const out = await run(
			[
				labelsOk,
				[QUEUE, issueRows()],
				[SEARCH, issueRows()],
				[/state=closed/, {status: 503, body: "{}"}],
			],
			{closedDays: 14},
		);
		expect(out.code).toBe(SEARCH_UNREADABLE);
		expect(out.stdout).toBe("");
	});

	it.each([-1, 36501])("refuses invalid closed window %s", async (closedDays) => {
		const out = await run([], {closedDays});
		expect(out.code).toBe(1);
		expect(out.stdout).toBe("");
	});

	it("says on stderr when the cap truncated the list", async () => {
		const rows = Array.from({length: 4}, (_, i) => [i + 1, "retry helper abort reason"] as const);
		const out = await run([labelsOk, [QUEUE, issueRows(...rows)], [SEARCH, searchHits()]], {
			limit: 2,
		});
		expect(out.stdout.split("\n").filter((l) => l !== "")).toHaveLength(3);
		expect(out.stderr.join("\n")).toContain("TRUNCATED");
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

it("reads the live queue even on a cache hit and overlays a new report", async () => {
	const cached = new IndexSnapshot({
		version: 1,
		repo: "o/r",
		closedDays: 0,
		fetchedAt: Date.now(),
		issues: [],
	});
	const fs = fakeFs({files: {"/cache/fabrika/dedup/o%2Fr-0.json": JSON.stringify(cached)}});
	const seams = fakeSeams([labelsOk, [QUEUE, issueRows([999, "retry helper"])]]);
	const out = await Effect.runPromise(
		Effect.provide(
			runDedup({...options, json: true, env: {...options.env, XDG_CACHE_HOME: "/cache"}}),
			Layer.mergeAll(fs.layer, seams.layer, NodeCrypto.layer),
		),
	);
	expect(out.code).toBe(0);
	expect(JSON.parse(out.stdout)).toMatchObject({
		candidates: [{number: 999, source: "queue"}],
		cache: {source: "cache"},
	});
	expect(seams.requests).toHaveLength(2);
});
