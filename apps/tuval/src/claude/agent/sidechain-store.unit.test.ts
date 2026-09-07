/**
 * The disk half of the subagent read, over a substituted filesystem: which files it opens, and
 * that every way it can fail comes back as its own refusal rather than as an empty transcript.
 */

import {homedir} from "node:os";
import {join} from "node:path";
import {Cause, Effect, Exit, FileSystem, Layer, Path, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {PageError} from "../../ai-agent/service/index.ts";
import {loadSidechain, SIDECHAIN_AGENT_ID} from "../history/fixtures/load.ts";
import {readSubagentTranscript} from "./sidechain-store.ts";

const AT = 1_700_000_000_000;
const SESSION = {cwd: "/tmp/tuval-capture", id: "00000000-0000-4000-8000-000000000001"} as const;
const capture = loadSidechain();

// The store resolves its own root, so the test builds the same one rather than pointing the read
// somewhere: `CLAUDE_CONFIG_DIR` unset is `~/.claude`, which is the case every desk runs under.
const PROJECTS = join(homedir(), ".claude", "projects");
const subagentsIn = (slug: string) => join(PROJECTS, slug, SESSION.id, "subagents");
const DIR = subagentsIn("-tmp-tuval-capture");

const jsonlIn = (dir: string) => join(dir, `agent-${SIDECHAIN_AGENT_ID}.jsonl`);
const metaIn = (dir: string) => join(dir, `agent-${SIDECHAIN_AGENT_ID}.meta.json`);

const gone = (path: string) =>
	PlatformError.systemError({
		_tag: "NotFound",
		module: "FileSystem",
		method: "read",
		pathOrDescriptor: path,
	});

/** A store as a flat path→text map: anything absent is absent, and a directory is its prefix. */
const store = (
	files: Readonly<Record<string, string>>,
	overrides: Partial<FileSystem.FileSystem> = {},
): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	Layer.merge(
		FileSystem.layerNoop({
			exists: (path) =>
				Effect.succeed(
					Object.keys(files).some((one) => one === path || one.startsWith(`${path}/`)),
				),
			readFileString: (path) => {
				const held = files[path];
				return held === undefined ? Effect.fail(gone(path)) : Effect.succeed(held);
			},
			...overrides,
		}),
		Path.layer,
	);

const whole: Readonly<Record<string, string>> = {
	[jsonlIn(DIR)]: capture.jsonl,
	[metaIn(DIR)]: capture.meta,
};

const readWith = (
	files: Readonly<Record<string, string>>,
	overrides?: Partial<FileSystem.FileSystem>,
	session: {readonly cwd: string; readonly id: string} = SESSION,
	agentId: string = SIDECHAIN_AGENT_ID,
) =>
	Effect.runSyncExit(
		readSubagentTranscript(session, agentId, AT).pipe(Effect.provide(store(files, overrides))),
	);

const refusalOf = (exit: Exit.Exit<unknown, unknown>): PageError => {
	if (!Exit.isFailure(exit)) throw new Error("the read succeeded where it should have refused");
	const error = Cause.squash(exit.cause);
	if (!(error instanceof PageError)) throw new Error(`not a PageError: ${String(error)}`);
	return error;
};

describe("readSubagentTranscript over a captured subagent", () => {
	it("answers its items and its type", () => {
		const exit = readWith(whole);
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(exit.value.type).toBe("probe-plugin:probe-grep");
		expect(exit.value.items.map((one) => one.kind)).toEqual([
			"user",
			"thinking",
			"assistant",
			"tool",
			"thinking",
			"assistant",
		]);
	});

	it("still answers the items when the meta file is gone, under the unnamed type", () => {
		const exit = readWith({[jsonlIn(DIR)]: capture.jsonl});
		expect(Exit.isSuccess(exit)).toBe(true);
		if (!Exit.isSuccess(exit)) return;
		expect(exit.value.type).toBe("subagent");
		expect(exit.value.items).toHaveLength(6);
	});

	it("scans the store when the project name the CLI wrote is not the derived one", () => {
		const moved = subagentsIn("-private-tmp-tuval-capture");
		const exit = readWith(
			{[jsonlIn(moved)]: capture.jsonl, [metaIn(moved)]: capture.meta},
			{
				readDirectory: () => Effect.succeed(["-private-tmp-tuval-capture"]),
			},
		);
		expect(Exit.isSuccess(exit)).toBe(true);
	});
});

describe("every way the read can fail is its own refusal", () => {
	it("refuses a subagent with no transcript file, rather than answering nothing", () => {
		const exit = readWith(whole, undefined, SESSION, "a0000000000000000");
		expect(refusalOf(exit).reason).toBe("subagent-not-found");
	});

	it("refuses a session no directory in the store holds", () => {
		const exit = readWith(
			whole,
			{readDirectory: () => Effect.succeed(["-tmp-tuval-capture"])},
			{cwd: "/tmp/elsewhere", id: "00000000-0000-4000-8000-00000000dead"},
		);
		expect(refusalOf(exit).reason).toBe("subagent-not-found");
	});

	it("refuses a store directory that will not open", () => {
		const exit = readWith(
			whole,
			{readDirectory: () => Effect.fail(gone(PROJECTS))},
			{
				cwd: "/tmp/elsewhere",
				id: SESSION.id,
			},
		);
		expect(refusalOf(exit).reason).toBe("store-unreadable");
	});

	it("refuses a malformed line and names it, rather than answering the lines it could read", () => {
		const exit = readWith({...whole, [jsonlIn(DIR)]: `${capture.jsonl}{oh no\n`});
		const refusal = refusalOf(exit);
		expect(refusal.reason).toBe("subagent-malformed");
		expect(refusal.detail).toContain("line 8");
	});
});
