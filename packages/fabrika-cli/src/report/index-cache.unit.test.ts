import {NodeCrypto} from "@effect/platform-node";
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, linkNext, type Scripted} from "../fakes.test-support.ts";
import {CACHE_TTL_MS, IndexSnapshot, loadIndex} from "./index-cache.ts";

const now = Date.parse("2026-09-19T12:00:00Z");
const env = {XDG_CACHE_HOME: "/cache"};
const file = "/cache/fabrika/dedup/o%2Fr-14.json";
const doc = {
	number: 1,
	title: "retry helper",
	body: "reason lost",
	state: "open" as const,
	closed_at: null,
};
const snapshot = (fetchedAt = now, repo = "o/r") =>
	new IndexSnapshot({version: 1, repo, closedDays: 14, fetchedAt, issues: [doc]});
const reads: ReadonlyArray<Scripted> = [
	[/state=open/, {status: 200, body: JSON.stringify([doc])}],
	[/state=closed/, {status: 200, body: "[]"}],
];
const run = (
	fs: ReturnType<typeof fakeFs>,
	seams: ReturnType<typeof fakeSeams>,
	refresh = false,
	repo = "o/r",
	days = 14,
) =>
	Effect.runPromise(
		Effect.provide(
			loadIndex(repo, days, now, refresh, env),
			Layer.mergeAll(fs.layer, seams.layer, NodeCrypto.layer),
		),
	);

describe("index cache", () => {
	it("reuses a fresh snapshot without any GitHub reads", async () => {
		const seams = fakeSeams([]);
		const result = await run(fakeFs({files: {[file]: JSON.stringify(snapshot(now - 10))}}), seams);
		expect(result).toMatchObject({
			_tag: "Ok",
			value: {issues: [doc], cache: {source: "cache", ageMs: 10}},
		});
		expect(seams.requests).toEqual([]);
	});
	it.each([
		"missing",
		"corrupt",
		"expired",
		"future",
		"wrong-repo",
		"wrong-window",
		"bad-row",
	])("refreshes a %s snapshot", async (kind) => {
		const files: Record<string, string> = {};
		const variants: Record<string, unknown> = {
			corrupt: null,
			expired: snapshot(now - CACHE_TTL_MS),
			future: snapshot(now + 1),
			"wrong-repo": snapshot(now, "other/repo"),
			"wrong-window": {...snapshot(), closedDays: 7},
			"bad-row": {...snapshot(), issues: [{...doc, state: "closed", closed_at: null}]},
		};
		if (kind !== "missing") files[file] = JSON.stringify(variants[kind]);
		const fs = fakeFs({files});
		const seams = fakeSeams(reads);
		const result = await run(fs, seams);
		expect(result).toMatchObject({_tag: "Ok", value: {cache: {source: "fetched"}, issues: [doc]}});
		expect(seams.requests).toHaveLength(2);
		expect(JSON.parse(fs.written.get(file) ?? "null")).toMatchObject({repo: "o/r", issues: [doc]});
	});
	it("honors explicit refresh even when the cache is fresh", async () => {
		const seams = fakeSeams(reads);
		const result = await run(fakeFs({files: {[file]: JSON.stringify(snapshot())}}), seams, true);
		expect(result).toMatchObject({_tag: "Ok", value: {cache: {source: "fetched"}}});
		expect(seams.requests).toHaveLength(2);
	});
	it("does not use one repository's cache for another repository", async () => {
		const fs = fakeFs({files: {[file]: JSON.stringify(snapshot())}});
		const result = await run(fs, fakeSeams(reads), false, "other/repo");
		expect(result).toMatchObject({_tag: "Ok", value: {cache: {source: "fetched"}}});
		expect(
			JSON.parse(fs.written.get("/cache/fabrika/dedup/other%2Frepo-14.json") ?? "null").repo,
		).toBe("other/repo");
	});
	it("does not fall back to stale data after a failed fetch", async () => {
		const fs = fakeFs({files: {[file]: JSON.stringify(snapshot(now - CACHE_TTL_MS))}});
		const result = await run(fs, fakeSeams([[/state=open/, {status: 503, body: "{}"}]]));
		expect(result._tag).toBe("Failure");
		expect(fs.written.size).toBe(0);
	});
	it("uses the fetched corpus when cache publication fails", async () => {
		const result = await run(fakeFs({unwritable: ["/cache/fabrika/dedup"]}), fakeSeams(reads));
		expect(result).toMatchObject({
			_tag: "Ok",
			value: {
				issues: [doc],
				diagnostics: ["report dedup: cache write failed; using the fetched corpus for this run."],
			},
		});
	});
	it("rechecks the rolling closed boundary on a cache hit", async () => {
		const closed = {
			...doc,
			state: "closed",
			closed_at: new Date(now - 14 * 86400000 - 1).toISOString(),
		};
		const stored = {...snapshot(now - 10), issues: [doc, {...closed, number: 2}]};
		const result = await run(fakeFs({files: {[file]: JSON.stringify(stored)}}), fakeSeams([]));
		expect(result).toMatchObject({_tag: "Ok", value: {issues: [doc]}});
	});
	it("publishes concurrent refreshes using distinct temporary files and one complete snapshot", async () => {
		const fs = fakeFs({});
		const results = await Promise.all([
			run(fs, fakeSeams(reads), true),
			run(fs, fakeSeams(reads), true),
		]);
		expect(results.map((result) => result._tag)).toEqual(["Ok", "Ok"]);
		expect([...fs.written.keys()].filter((name) => name.endsWith(".tmp"))).toHaveLength(2);
		const reused = await run(fs, fakeSeams([]));
		expect(reused).toMatchObject({_tag: "Ok", value: {issues: [doc], cache: {source: "cache"}}});
	});
	it("never requests closed issues when the window is zero", async () => {
		const seams = fakeSeams([[/state=open/, {status: 200, body: JSON.stringify([doc])}]]);
		const result = await run(fakeFs({}), seams, false, "o/r", 0);
		expect(result._tag).toBe("Ok");
		expect(seams.requests).toHaveLength(1);
	});
});

it("refuses a capped pagination walk and never writes a partial cache", async () => {
	const fs = fakeFs({});
	const seams = fakeSeams([
		[
			/state=open/,
			{
				status: 200,
				body: JSON.stringify([doc]),
				headers: linkNext("https://api.github.com/repos/o/r/issues?page=2"),
			},
		],
	]);
	const result = await run(fs, seams);
	expect(result).toMatchObject({_tag: "Failure"});
	expect(fs.written.size).toBe(0);
	expect(seams.requests).toHaveLength(50);
});

it("filters pull requests before validating issue documents", async () => {
	const seams = fakeSeams([
		[
			/state=open/,
			{status: 200, body: JSON.stringify([{pull_request: {url: "https://example.com/pr"}}, doc])},
		],
	]);
	const result = await run(fakeFs({}), seams, false, "o/r", 0);
	expect(result).toMatchObject({_tag: "Ok", value: {issues: [doc]}});
});
