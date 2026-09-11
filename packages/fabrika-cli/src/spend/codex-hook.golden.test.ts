import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, expect, it} from "vitest";
import {loadGoldenPayload, readGoldenFixture} from "../golden-fixture.ts";
import {runCodexHook} from "./codex-hook-verb.ts";
import {readUsageLedger} from "./usage-ledger.ts";

const fixture = "__fixtures__/codex-session-start.payload.golden.json";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

it("accepts the captured native SessionStart key set without inventing a turn or tool", async () => {
	const event = loadGoldenPayload(import.meta.url, fixture);
	expect(Object.keys(event).sort()).toEqual([
		"cwd",
		"hook_event_name",
		"model",
		"permission_mode",
		"session_id",
		"source",
		"transcript_path",
	]);
	expect(event).not.toHaveProperty("turn_id");
	expect(event).not.toHaveProperty("tool_input");
	expect(event).toMatchObject({hook_event_name: "SessionStart", source: "startup"});
	const dir = mkdtempSync(join(tmpdir(), "codex-golden-"));
	dirs.push(dir);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions);
	const transcript = join(sessions, "native.jsonl");
	writeFileSync(
		transcript,
		JSON.stringify({
			type: "session_meta",
			payload: {
				id: event.session_id,
				session_id: event.session_id,
				cli_version: "0.154.0",
				model_provider: "openai",
			},
		}),
	);
	const state = join(dir, "state");
	mkdirSync(join(state, "dispatch"), {recursive: true});
	writeFileSync(
		join(state, "dispatch", `${encodeURIComponent(dir)}.json`),
		JSON.stringify({
			work: {repo: "fixture/repo", issue: 8892, run: "captured-startup"},
		}),
	);
	const input = readGoldenFixture(import.meta.url, fixture)
		.replace(event.cwd as string, dir)
		.replace(event.transcript_path as string, transcript);
	const ledger = join(dir, "ledger.jsonl");
	const result = await Effect.runPromise(
		runCodexHook({input, sessions, state, ledger, repo: "fixture/repo"}).pipe(
			Effect.provide(NodeServices.layer),
		),
	);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).not.toHaveProperty("decision");
	expect(JSON.parse(result.stdout).systemMessage).toContain("No supported response records");
	const read = readUsageLedger(readFileSync(ledger, "utf8"));
	expect(read.records).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "participant",
				participant: event.session_id,
				state: "usage-missing",
				work: {
					repo: "fixture/repo",
					issue: 8892,
					run: "captured-startup",
					attempt: event.session_id,
				},
			}),
		]),
	);
	expect(read.records.filter((row) => row.kind === "measurement")).toEqual([]);
});
