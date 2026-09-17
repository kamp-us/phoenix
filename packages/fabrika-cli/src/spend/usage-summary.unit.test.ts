import {readFileSync} from "node:fs";
import {Effect} from "effect";
import {expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {encodeSpendRows} from "./ledger.ts";
import {runLedgerRead} from "./read-verb.ts";
import {runRollup} from "./rollup-verb.ts";

const path = "/usage.jsonl";
const text = readFileSync(new URL("./fixtures/attributed/codex.json", import.meta.url), "utf8");
const layer = fakeFs({files: {[path]: JSON.stringify(JSON.parse(text))}}).layer;
const run = (json: boolean) =>
	Effect.runPromise(
		runRollup({ledger: path, since: null, until: null, issue: 42, json}).pipe(
			Effect.provide(layer),
		),
	);

it("reads versioned issue totals with the same coverage and counters in JSON and text", async () => {
	const json = await run(true);
	expect(json.code).toBe(0);
	const summary = JSON.parse(json.stdout);
	expect(summary.usage.responses).toBe(1);
	expect(summary.usage.scope.issue).toBe(42);
	const text = await run(false);
	expect(text.code).toBe(0);
	for (const [key, value] of Object.entries(summary.usage)) {
		expect(text.stdout).toContain(`usage.${key}\t${JSON.stringify(value)}`);
	}
	const read = await Effect.runPromise(runLedgerRead(path).pipe(Effect.provide(layer)));
	expect(JSON.parse(read.stdout).usage.counters).toEqual(summary.usage.counters);
});

it("keeps legacy totals separate and distinguishes damage from future records", async () => {
	const legacy = encodeSpendRows([
		{
			skillName: "build",
			stage: "build",
			caseId: 1,
			arm: "old",
			model: "old-model",
			sessionId: "old",
			cliVersion: "old",
			recordedAt: "2026-01-01T00:00:00Z",
			spend: {
				_tag: "Reconstructed",
				spend: {
					input: 3,
					output: 2,
					cacheCreate: 4,
					cacheRead: 5,
					billed: 14,
					exCacheRead: 9,
					assistantTurns: 1,
					model: "old-model",
				},
			},
		},
	]);
	const mixed = [legacy.trim(), JSON.stringify(JSON.parse(text)), "interrupted", '{"v":99}'].join(
		"\n",
	);
	const layer = fakeFs({files: {[path]: mixed}}).layer;
	const out = await Effect.runPromise(
		runRollup({ledger: path, since: null, until: null, json: true}).pipe(Effect.provide(layer)),
	);
	expect(out.code).toBe(0);
	const summary = JSON.parse(out.stdout);
	expect(summary.totals.billed).toBe(14);
	expect(summary.legacy).toMatchObject({attribution: "unavailable"});
	expect(summary.usage.responses).toBe(1);
	expect(summary.usage.diagnostics).toMatchObject({malformed: 1, newerVersion: 1});
	const bounded = await Effect.runPromise(
		runRollup({ledger: path, since: "2026-01-01", until: null, json: true}).pipe(
			Effect.provide(layer),
		),
	);
	expect(bounded.code).toBe(1);
	expect(bounded.stderr.join(" ")).toContain("no timestamps");
});

it("names absent and unreadable ledger inputs separately", async () => {
	const missing = await Effect.runPromise(
		runLedgerRead(path).pipe(Effect.provide(fakeFs({files: {[path]: null}}).layer)),
	);
	expect(missing.code).toBe(7);
	expect(missing.stderr.join(" ")).toContain("ledger absent;");
	const unreadable = await Effect.runPromise(
		runLedgerRead(path).pipe(
			Effect.provide(fakeFs({files: {[path]: text}, unreadable: [path]}).layer),
		),
	);
	expect(unreadable.code).toBe(11);
	expect(unreadable.stderr.join(" ")).toContain("ledger unreadable;");
});
