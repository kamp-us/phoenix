import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {runDisarm} from "./disarm-verb.ts";
import {ENV, pull} from "./fixtures.test-support.ts";
import {ADDED, REMOVED} from "./queue.ts";

const PULL = /^GET \S+\/repos\/o\/r\/pulls\/4321$/;

const TIMELINE = /\/repos\/o\/r\/issues\/4321\/timeline/;
const RULES = /\/repos\/o\/r\/rules\/branches\/main/;
const GRAPHQL = /\/graphql$/;

/** The PR read, served — the same canned payload the spawner era scripted. */
const pullServed = (shape: Parameters<typeof pull>[0] = {}): HttpReply => ({
	status: 200,
	body: pull(shape).stdout,
});

/** A terminal page of the PR's timeline — no `Link` header, which is the completeness proof. */
const timeline = (...rows: ReadonlyArray<{event: string; at: string}>): HttpReply => ({
	status: 200,
	body: JSON.stringify(rows.map((row) => ({event: row.event, created_at: row.at}))),
});

/**
 * Both auto-merge legs answered by one payload.
 *
 * Disarming reads the PR's node id and then posts the mutation, and the reader looks up only the
 * key it needs — so a body carrying both keys serves either leg without scripting request order.
 */
const disarmed: HttpReply = {
	status: 200,
	body: JSON.stringify({
		data: {
			repository: {pullRequest: {id: "PR_kwDOnode"}},
			disablePullRequestAutoMerge: {clientMutationId: null},
		},
	}),
};

const options = {pr: 4321, site: "preflight", repo: null, json: false, env: ENV};

const layers = (script: ReadonlyArray<Scripted>) => fakeSeams(script);

const run = (
	script: ReadonlyArray<Scripted>,
	http: ReadonlyArray<Scripted> = [],
	overrides: Partial<typeof options> = {},
) =>
	Effect.runPromise(
		Effect.provide(runDisarm({...options, ...overrides}), layers([...script, ...http]).layer),
	);

const noQueue: HttpReply = {status: 200, body: JSON.stringify([])};
const _withQueue: HttpReply = {status: 200, body: JSON.stringify([{type: "merge_queue"}])};

describe("runDisarm", () => {
	it("keeps a never-armed intent and says so", async () => {
		const out = await run([[PULL, pullServed()]], [[TIMELINE, timeline()]]);
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("disarm\tkept\tpreflight\tnot-armed\n");
	});

	it("clears an armed intent and PROVES it from the re-read", async () => {
		const scripted = layers([
			[once(PULL), pullServed({autoMerge: true})],
			[PULL, pullServed({autoMerge: false})],
			[TIMELINE, timeline()],
			[GRAPHQL, disarmed],
		]);
		const out = await Effect.runPromise(Effect.provide(runDisarm(options), scripted.layer));
		expect(out.stdout).toBe("disarm\tdisarmed\tpreflight\tcleared\n");
		expect(scripted.bodies.some((body) => body.includes("disablePullRequestAutoMerge"))).toBe(true);
		// The queue owns the merge method, so the mutation must not name one — `mergeMethod` is the
		// GraphQL spelling of the `--squash`-alongside-`--auto` trap that no-ops the enqueue silently.
		expect(scripted.bodies.some((body) => body.includes("mergeMethod"))).toBe(false);
	});

	it("never disturbs a live queue entry", async () => {
		const scripted = layers([
			[PULL, pullServed({autoMerge: true})],
			[TIMELINE, timeline({event: ADDED, at: "2026-08-08T10:00:00Z"})],
		]);
		const out = await Effect.runPromise(Effect.provide(runDisarm(options), scripted.layer));
		expect(out.stdout).toBe("disarm\tkept\tpreflight\tlive-queued\n");
		expect(scripted.bodies.some((body) => body.includes("disablePullRequestAutoMerge"))).toBe(
			false,
		);
	});

	it("keeps the intent off a queue-less base at post-enqueue — there `--auto` IS the mechanism", async () => {
		const out = await run(
			[[PULL, pullServed({autoMerge: true})]],
			[
				[TIMELINE, timeline({event: REMOVED, at: "2026-08-08T10:00:00Z"})],
				[RULES, noQueue],
			],
			{site: "post-enqueue"},
		);
		expect(out.stdout).toBe("disarm\tkept\tpost-enqueue\tpre-queue-regime\n");
	});

	it("reads an UNREADABLE regime as queue-governed, so a failed read cannot grant the keep", async () => {
		const out = await run(
			[
				[once(PULL), pullServed({autoMerge: true})],
				[PULL, pullServed({autoMerge: false})],
			],
			[
				[TIMELINE, timeline()],
				[RULES, {status: 502, body: '{"message":"Bad gateway"}'}],
				[GRAPHQL, disarmed],
			],
			{site: "post-enqueue"},
		);
		expect(out.stdout).toBe("disarm\tdisarmed\tpost-enqueue\tcleared\n");
	});

	it("answers `kept merged` for a merged PR rather than refusing — there is no 7 seat here", async () => {
		const out = await run([[PULL, pullServed({merged: true, state: "closed"})]], [], {
			site: "ejected",
		});
		expect(out.code).toBe(0);
		expect(out.stdout).toBe("disarm\tkept\tejected\tmerged\n");
	});

	it("refuses on 8 when the re-read cannot confirm the intent is clear", async () => {
		const out = await run(
			[[PULL, pullServed({autoMerge: true})]],
			[
				[TIMELINE, timeline()],
				// The node-id read lands; the mutation behind it is what fails.
				[once(GRAPHQL), disarmed],
				[GRAPHQL, {status: 502, body: '{"message":"Bad gateway"}'}],
			],
		);
		expect(out.code).toBe(WRITE_UNKNOWN);
		expect(out.stderr.at(-1)).toContain('report "merge intent: NOT cleared"');
	});

	it("refuses an unreadable merge state on 11 before any write is attempted", async () => {
		const scripted = layers([[PULL, {status: 502, body: '{"message":"Bad gateway"}'}]]);
		const out = await Effect.runPromise(Effect.provide(runDisarm(options), scripted.layer));
		expect(out.code).toBe(PRECONDITION_UNKNOWN);
		expect(scripted.bodies.some((body) => body.includes("disablePullRequestAutoMerge"))).toBe(
			false,
		);
	});

	it("refuses an off-vocabulary --site on 10", async () => {
		const out = await run([[PULL, pullServed()]], [], {site: "later"});
		expect(out.code).toBe(OFF_VOCABULARY);
		expect(out.stderr.at(-1)).toBe(
			"ship disarm: --site later is not a lifecycle site (preflight, refuse, post-enqueue, ejected).",
		);
	});
});
