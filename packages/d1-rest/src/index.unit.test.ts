/**
 * The canonical D1 REST transport's contract, tested ONCE here for all three
 * consumers (issue #941) — previously the same assertions lived in triplicate
 * (preview-seed's `seed.unit.test.ts`, fts-backfill's `backfill.batch.unit.test.ts`,
 * moderator-grant's `d1-rest.unit.test.ts`). All three checks run with no CF creds and
 * no SQL engine (ADR 0082 unit tier): the param transform is pure, and the
 * `makeD1Rest` shape assertions drive the real REST adapter offline over a fake
 * `FetchHttpClient.Fetch`. The faithful proof that real D1 actually rejects null /
 * flips a row lives on each consumer's integration tier.
 */
import {fromApiToken} from "@distilled.cloud/cloudflare/Credentials";
import {assert, describe, it} from "@effect/vitest";
import {Layer} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {assertRestParam, makeD1Rest, readYourWrite, toRestParams} from "./index.ts";

const restD1 = (fetch: typeof globalThis.fetch): D1Database =>
	makeD1Rest({
		accountId: "acc",
		databaseId: "db",
		layer: Layer.mergeAll(
			FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch))),
			// A token is enough for the shape assertions; nothing here hits real CF.
			fromApiToken({apiToken: "test-token"}),
		),
	});

describe("toRestParams / assertRestParam — D1 REST rejects null params (#569)", () => {
	it("rejects a null or undefined bound param with the wire-contract message", () => {
		for (const bad of [null, undefined]) {
			assert.throws(
				() => assertRestParam(bad, 0),
				/strict string\[\] and rejects null/,
				`binding ${bad} must throw`,
			);
			assert.throws(() => toRestParams([bad]), /strict string\[\] and rejects null/);
		}
	});

	it("stringifies a non-null param the REST client accepts (numbers, strings, booleans)", () => {
		assert.deepStrictEqual(toRestParams([42, "x", true]), ["42", "x", "true"]);
	});
});

// #940: `run()` once hardcoded `meta: {}`, dropping D1's row-change count — latent in the
// seed (no consumer reads it) but it bit moderator-grant's setRole (#937). Lock the REST
// `result: [{ meta: { changes } }]` → `meta.changes` mapping so it can't regress, driving
// the real REST adapter offline over a fake Fetch (no CF creds).
describe("makeD1Rest — run() carries D1's row-change count (#937/#940)", () => {
	const respond =
		(result: unknown): typeof globalThis.fetch =>
		async () =>
			new Response(JSON.stringify({result}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});

	it("maps result[0].meta.changes from the REST response", async () => {
		const d1 = restD1(respond([{meta: {changes: 3}, results: [], success: true}]));
		const res = await d1.prepare("update x set y = ? where z = ?").bind("a", "b").run();
		assert.strictEqual(res.meta.changes, 3);
	});

	it("defaults meta.changes to 0 when the response carries none", async () => {
		const d1 = restD1(respond([{results: [], success: true}]));
		const res = await d1.prepare("update x set y = ? where z = ?").bind("a", "b").run();
		assert.strictEqual(res.meta.changes, 0);
	});
});

// The batch slice is load-bearing for the consumers' all-or-none writes: every bound
// statement's sql+params must travel in ONE REST `query` POST, in source order — not N
// independent calls. Drive it offline, recording what reaches the fake Fetch.
describe("makeD1Rest — batch is one REST POST carrying every statement in order", () => {
	it("sends the whole batch as a single /query POST, sql+params in order", async () => {
		const requests: {url: string; body: {batch?: {sql: string; params: string[]}[]}}[] = [];

		const fakeFetch: typeof globalThis.fetch = async (input, init) => {
			const raw = init?.body;
			const text =
				typeof raw === "string"
					? raw
					: raw instanceof Uint8Array
						? new TextDecoder().decode(raw)
						: await new Response(raw as BodyInit).text();
			requests.push({url: String(input), body: text ? JSON.parse(text) : {}});
			return new Response(JSON.stringify({result: [{meta: {}, results: [], success: true}]}), {
				status: 200,
				headers: {"content-type": "application/json"},
			});
		};

		const d1 = restD1(fakeFetch);

		await d1.batch([
			d1.prepare("delete from t where slug = ?").bind("sisli"),
			d1.prepare("insert into t (slug, norm) values (?, ?)").bind("sisli", "sisli"),
		]);

		assert.strictEqual(requests.length, 1);
		assert.isTrue(requests[0]!.url.includes("/d1/database/db/query"));
		const batch = requests[0]!.body.batch!;
		assert.strictEqual(batch.length, 2);
		assert.strictEqual(batch[0]!.sql, "delete from t where slug = ?");
		assert.deepStrictEqual(batch[0]!.params, ["sisli"]);
		assert.strictEqual(batch[1]!.sql, "insert into t (slug, norm) values (?, ?)");
		assert.deepStrictEqual(batch[1]!.params, ["sisli", "sisli"]);
	});
});

// The REST /query endpoint carries no D1 session bookmark (verified against the pinned
// `@distilled.cloud/cloudflare` `QueryDatabaseRequest` schema), so an immediate read after a
// write has no read-your-writes guarantee — the #3075 künye flake. `readYourWrite` re-reads until
// the caller's known post-write truth holds, and — load-bearing — returns the LAST value on
// exhaustion so a genuinely-wrong read still fails the caller's assertion rather than being masked.
describe("readYourWrite — bounded read-your-writes poll (#3075/#3078)", () => {
	// A sleep double that resolves at once (no real timers) and records each backoff it was asked
	// for, so the poll's cadence is asserted without waiting.
	const recordingSleep = () => {
		const delays: number[] = [];
		return {delays, sleep: async (ms: number) => void delays.push(ms)};
	};

	it("returns the first read when it is already consistent (no sleep, no re-read)", async () => {
		let reads = 0;
		const {delays, sleep} = recordingSleep();
		const value = await readYourWrite(
			async () => {
				reads++;
				return true;
			},
			(v) => v === true,
			{sleep},
		);
		assert.strictEqual(value, true);
		assert.strictEqual(reads, 1);
		assert.deepStrictEqual(delays, []);
	});

	it("re-reads until the write is observed, then returns the consistent value", async () => {
		// The write becomes visible on the 3rd read (stale, stale, present).
		const seq = [false, false, true];
		let i = 0;
		const {delays, sleep} = recordingSleep();
		const value = await readYourWrite(
			async () => seq[i++]!,
			(v) => v === true,
			{sleep, baseDelayMs: 100},
		);
		assert.strictEqual(value, true);
		assert.strictEqual(i, 3);
		// Two backoffs before the 2nd and 3rd reads, exponential from the base.
		assert.deepStrictEqual(delays, [100, 200]);
	});

	it("returns the LAST value on budget exhaustion — a genuinely-absent write is not masked", async () => {
		let reads = 0;
		const {delays, sleep} = recordingSleep();
		const value = await readYourWrite(
			async () => {
				reads++;
				return false;
			},
			(v) => v === true,
			{sleep, maxAttempts: 4, baseDelayMs: 50},
		);
		// Never became consistent → the real (false) read is returned so the caller's own assertion
		// fails loudly; the poll never fabricates `true`.
		assert.strictEqual(value, false);
		assert.strictEqual(reads, 4);
		assert.deepStrictEqual(delays, [50, 100, 200]);
	});
});
