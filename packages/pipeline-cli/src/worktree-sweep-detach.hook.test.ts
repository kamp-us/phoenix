/**
 * The SessionStart sweep entry returns without waiting for the sweep (#4998).
 *
 * The acceptance property is structural, not "the sweep got faster": the hook must return
 * while the sweep is still running. So these tests drive the REAL scripts against a throwaway
 * data dir whose stub `pipeline-cli` sleeps — if the hook ever went back to waiting, the
 * elapsed-time assertion fails by the length of that sleep, whatever the machine's load.
 *
 * The other half is that the detached run stays observable: its exit status is recorded and a
 * failed run is reported at the next session start.
 */
import {execFileSync, spawnSync} from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, assert, describe, it} from "@effect/vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "./test-budget.ts";

const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

const HOOKS = "claude-plugins/kampus-pipeline/hooks";
const DETACH_SH = repoPath(`${HOOKS}/worktree-sweep-detach.sh`);
const PIN_SH = repoPath(`${HOOKS}/pin.sh`);

const hookPin = (): string =>
	execFileSync("bash", ["-c", `. "${PIN_SH}"; printf '%s' "$KAMPUS_PIPELINE_CLI_PIN"`], {
		encoding: "utf8",
	});

/** How long the stub sweep runs. Long enough that a blocking hook cannot hide inside jitter. */
const STUB_SLEEP_S = 5;

/**
 * A throwaway pipeline data dir holding a stub `pipeline-cli` that sleeps, then drops a
 * sentinel — so "did the sweep run, and did the hook wait for it?" are separately answerable.
 */
const dataDirWithSlowStub = (exitCode: number): string => {
	const data = mkdtempSync(join(tmpdir(), "sweep-detach-"));
	const bin = join(data, "node_modules", ".bin", "pipeline-cli");
	mkdirSync(dirname(bin), {recursive: true});
	writeFileSync(
		bin,
		`#!/usr/bin/env bash\nsleep ${STUB_SLEEP_S}\necho "SWEPT $*"\ntouch "${join(data, "sentinel")}"\nexit ${exitCode}\n`,
	);
	chmodSync(bin, 0o755);
	writeFileSync(join(data, ".pipeline-cli.version"), hookPin());
	return data;
};

const runDetach = (data: string) =>
	spawnSync("bash", [DETACH_SH], {
		encoding: "utf8",
		input: '{"session_id":"t","hook_event_name":"SessionStart","source":"startup"}',
		env: {...process.env, KAMPUS_PIPELINE_DATA: data},
	});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The detached child writes its status file after the hook has already returned — that gap is the point. */
const waitForFile = async (path: string, budgetMs: number): Promise<void> => {
	const deadline = Date.now() + budgetMs;
	while (!existsSync(path) && Date.now() < deadline) await sleep(50);
};

describe("SessionStart sweep entry — dispatches, never blocks (#4998)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const dirs: string[] = [];
	const dataDir = (exitCode = 0) => {
		const d = dataDirWithSlowStub(exitCode);
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
	});

	it("returns while the sweep is still running, and the sweep completes after it", async () => {
		const data = dataDir();
		const started = Date.now();
		const {status} = runDetach(data);
		const elapsedMs = Date.now() - started;

		assert.strictEqual(status, 0, "the hook entry must exit 0");
		assert.isBelow(
			elapsedMs,
			STUB_SLEEP_S * 1000,
			`the hook returned in ${elapsedMs}ms — it must not wait for the ${STUB_SLEEP_S}s sweep`,
		);
		assert.isFalse(
			existsSync(join(data, "sentinel")),
			"the sweep must still be running when the hook returns",
		);

		await waitForFile(join(data, "worktree-sweep.status"), 2000);
		assert.strictEqual(
			readFileSync(join(data, "worktree-sweep.status"), "utf8").split(" ")[0],
			"running",
			"the detached run must be recorded as in flight",
		);

		await sleep((STUB_SLEEP_S + 3) * 1000);
		assert.isTrue(
			existsSync(join(data, "sentinel")),
			"the detached sweep must actually run to completion",
		);
		assert.match(readFileSync(join(data, "worktree-sweep.status"), "utf8"), /^exit 0 /);
		assert.match(
			readFileSync(join(data, "worktree-sweep.log"), "utf8"),
			/SWEPT worktree-sweep --execute/,
		);
	});

	it("keeps a failed run's output and reports it at the next session start", async () => {
		const data = dataDir(3);
		runDetach(data);
		await sleep((STUB_SLEEP_S + 3) * 1000);
		assert.match(readFileSync(join(data, "worktree-sweep.status"), "utf8"), /^exit 3 /);
		assert.isTrue(
			existsSync(join(data, "worktree-sweep.failed.log")),
			"a failed run's output must survive",
		);

		const {status, stderr} = runDetach(data);
		assert.strictEqual(status, 0, "reporting a prior failure must not abort the session");
		assert.match(stderr, /previous background worktree-sweep FAILED \(exit 3 /);
	});

	it("fails open when the data dir does not resolve", () => {
		const {status, stderr} = spawnSync("bash", [DETACH_SH], {
			encoding: "utf8",
			input: '{"hook_event_name":"SessionStart"}',
			env: {
				...process.env,
				KAMPUS_PIPELINE_DATA: join(tmpdir(), "sweep-detach-absent"),
				CLAUDE_PLUGIN_DATA: "",
				CLAUDE_PROJECT_DIR: "",
			},
		});
		assert.strictEqual(status, 0, "#1050: a refusal to dispatch still exits 0");
		assert.strictEqual(
			stderr,
			"",
			"an unresolvable data dir is the expected cold-consumer state, not a warning",
		);
	});
});
