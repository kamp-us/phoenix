import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, expect, it} from "vitest";
import {collectCodex} from "./codex-collector.ts";
import {readUsageLedger} from "./usage-ledger.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});
const live = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));
const usage = {
	input_tokens: 100,
	cached_input_tokens: 20,
	cache_write_input_tokens: 5,
	output_tokens: 10,
	reasoning_output_tokens: 3,
	total_tokens: 110,
};
const meta = (id: string, parent: string | null = null, version = "0.154.0") => ({
	type: "session_meta",
	payload: {
		id,
		session_id: "root",
		parent_thread_id: parent,
		cli_version: version,
		model_provider: "openai",
	},
});
const context = (turn = "turn-1", model = "model-a") => ({
	type: "turn_context",
	payload: {turn_id: turn, model},
});
const response = (thread = "root", id = "response-1", turn = "turn-1") => ({
	type: "token_usage_record",
	payload: {
		thread_id: thread,
		session_id: "root",
		turn_id: turn,
		root_turn_id: "turn-1",
		response_id: id,
		usage,
		turn_token_usage: usage,
		thread_token_usage: usage,
	},
});
const fixture = () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	return {
		sessions,
		ledger: join(dir, "ledger.jsonl"),
		rootThread: "root",
		work: {repo: "o/r", issue: 8950, run: "lane:8892"},
	};
};
const save = (dir: string, name: string, rows: unknown[]) =>
	writeFileSync(
		join(dir, `${name}.jsonl`),
		`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
it("records native response fields and distinct cumulative snapshots, idempotently", async () => {
	const options = fixture();
	save(options.sessions, "root", [meta("root"), context(), response()]);
	expect((await live(collectCodex(options))).notices).toEqual([]);
	await live(collectCodex(options));
	const records = readUsageLedger(readFileSync(options.ledger, "utf8")).records;
	const measured = records.filter((row) => row.kind === "measurement");
	expect(measured).toHaveLength(3);
	expect(measured[0]).toMatchObject({
		work: {issue: 8950, attempt: "root"},
		agent: {session: "root", nativeSession: "root"},
		model: "model-a",
		provider: "openai",
		basis: {kind: "response"},
	});
	expect(
		measured[0]?.counters.find((row) => row.field === "cache_write_input_tokens"),
	).toMatchObject({value: {state: "measured", tokens: 5}});
	expect(measured[0]?.counters.find((row) => row.field === "cached_output_tokens")).toMatchObject({
		value: {state: "unsupported"},
	});
	expect(records.find((row) => row.kind === "coverage")).toMatchObject({
		state: "partial",
		discovery: "unknown",
	});
});
it("follows nested children, skips copied parent history, and keeps resumes and retries distinct", async () => {
	const options = fixture();
	const inherited = [meta("root"), context(), response()];
	save(options.sessions, "root", inherited);
	save(options.sessions, "child", [
		meta("child", "root", "0.153.4"),
		...inherited,
		context(),
		response("child"),
		context("turn-2", "model-b"),
		response("child", "retry-2", "turn-2"),
	]);
	save(options.sessions, "grandchild", [
		meta("grandchild", "child"),
		context(),
		response("grandchild"),
	]);
	save(options.sessions, "unrelated", [meta("unrelated"), context(), response("unrelated")]);
	const first = await live(collectCodex(options));
	expect(first.participants).toEqual(["child", "grandchild", "root"]);
	expect(first.notices).toEqual([]);
	save(options.sessions, "resumed", [
		meta("child", "root", "0.153.4"),
		...inherited,
		context(),
		response("child"),
		context("turn-2", "model-b"),
		response("child", "retry-2", "turn-2"),
		response("child", "retry-3", "turn-2"),
	]);
	await live(collectCodex(options));
	await live(collectCodex(options));
	const records = readUsageLedger(readFileSync(options.ledger, "utf8")).records.filter(
		(row) => row.kind === "measurement" && row.basis.kind === "response",
	);
	expect(records).toHaveLength(5);
	expect(
		records.filter((row) => row.kind === "measurement" && row.model === "model-b"),
	).toHaveLength(2);
	expect(new Set(records.map((row) => row.work.attempt))).toEqual(
		new Set(["root", "child", "grandchild"]),
	);
});
it("persists missing and unsupported participants, then recovers without duplicating usage", async () => {
	const options = {...fixture(), expected: ["missing", "future"]};
	save(options.sessions, "root", [meta("root"), context(), response()]);
	save(options.sessions, "future", [
		meta("future", "root", "99.0.0"),
		context(),
		response("future"),
	]);
	const first = await live(collectCodex(options));
	expect(first.notices.join(" ")).toContain("Unsupported Codex schema");
	let records = readUsageLedger(readFileSync(options.ledger, "utf8")).records;
	expect(records).toContainEqual(
		expect.objectContaining({kind: "participant", participant: "future", state: "unsupported"}),
	);
	expect(records).toContainEqual(
		expect.objectContaining({kind: "participant", participant: "missing", state: "unreadable"}),
	);
	save(options.sessions, "missing", [meta("missing", "root"), context(), response("missing")]);
	await live(collectCodex(options));
	await live(collectCodex(options));
	records = readUsageLedger(readFileSync(options.ledger, "utf8")).records;
	expect(
		records.filter((row) => row.kind === "measurement" && row.basis.kind === "response"),
	).toHaveLength(2);
	expect(records.some((row) => row.kind === "coverage" && row.state === "complete")).toBe(false);
});
it("keeps interrupted records visible and replays after repair, including archived sessions", async () => {
	const options = fixture();
	save(options.sessions, "root", [meta("root"), context(), response()]);
	writeFileSync(
		join(options.sessions, "child.jsonl"),
		`${JSON.stringify(meta("child", "root"))}\n{"type":`,
	);
	const first = await live(collectCodex(options));
	expect(first.notices.join(" ")).toContain("Unreadable record");
	const archived = join(options.sessions, "..", "archived_sessions");
	mkdirSync(archived);
	rmSync(join(options.sessions, "child.jsonl"));
	save(archived, "child", [meta("child", "root"), context(), response("child")]);
	expect((await live(collectCodex(options))).notices).toEqual([]);
	const records = readUsageLedger(readFileSync(options.ledger, "utf8")).records;
	expect(
		records.filter((row) => row.kind === "measurement" && row.basis.kind === "response"),
	).toHaveLength(2);
	expect(records).toContainEqual(
		expect.objectContaining({kind: "participant", participant: "child", state: "usage-missing"}),
	);
});
it("preserves absent provider/model/counters and measured zero without inferring values", async () => {
	const options = fixture();
	const header = meta("root");
	delete (header.payload as {model_provider?: string}).model_provider;
	const row = response();
	delete (row.payload.usage as {cache_write_input_tokens?: number}).cache_write_input_tokens;
	row.payload.usage.reasoning_output_tokens = 0;
	save(options.sessions, "root", [header, row]);
	await live(collectCodex(options));
	const record = readUsageLedger(readFileSync(options.ledger, "utf8")).records.find(
		(row) => row.kind === "measurement",
	);
	expect(record).toMatchObject({model: null, provider: null});
	if (record?.kind !== "measurement") throw new Error("missing response");
	expect(record.counters.find((row) => row.category === "cacheWrite")).toMatchObject({
		value: {state: "absent"},
	});
	expect(record.counters.find((row) => row.category === "reasoning")).toMatchObject({
		value: {state: "measured", tokens: 0},
	});
});

it("filters native root turns and never turns token_count snapshots into responses", async () => {
	const options = {...fixture(), rootTurn: "turn-1"};
	const otherTurn = response("root", "other-response", "turn-2");
	otherTurn.payload.root_turn_id = "turn-2";
	save(options.sessions, "root", [
		meta("root"),
		context(),
		response(),
		otherTurn,
		{type: "event_msg", payload: {type: "token_count", info: {last_token_usage: usage}}},
	]);
	await live(collectCodex(options));
	const measured = readUsageLedger(readFileSync(options.ledger, "utf8")).records.filter(
		(row) => row.kind === "measurement",
	);
	expect(measured).toHaveLength(3);
	expect(measured.every((row) => row.rootTurn === "turn-1")).toBe(true);
});

it("reports native identity and counter gaps without manufacturing response usage", async () => {
	const options = fixture();
	const missingIdentity = response();
	missingIdentity.payload.response_id = "";
	const invalidCounts = response("root", "invalid");
	invalidCounts.payload.usage = {...usage, input_tokens: -1};
	const snapshotsOnly = response("root", "snapshots-only");
	delete (snapshotsOnly.payload as {usage?: unknown}).usage;
	save(options.sessions, "root", [
		meta("root"),
		context(),
		missingIdentity,
		invalidCounts,
		snapshotsOnly,
	]);
	const result = await live(collectCodex(options));
	expect(result.notices.join(" ")).toContain("Unsupported response identity");
	expect(result.notices.join(" ")).toContain("Unsupported usage");
	const measured = readUsageLedger(readFileSync(options.ledger, "utf8")).records.filter(
		(row) => row.kind === "measurement",
	);
	expect(measured).toHaveLength(4);
	expect(measured.every((row) => row.basis.kind === "cumulative")).toBe(true);
});
