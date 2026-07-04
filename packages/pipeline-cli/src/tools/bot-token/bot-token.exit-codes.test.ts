/**
 * Command-level exit-code contract for `pipeline-cli bot-token mint` (epic #1934, amends #1938).
 *
 * Proves the THREE distinct exit codes end-to-end by spawning the real bin with a sandboxed HOME
 * (so the org-derived `~/.config/kampus-pipeline/<org>/` cred dir is genuinely absent) and a forced
 * `--repo` (so no `gh` call is needed):
 *   - 3  not-configured — no config dir, no id/key env/flags → opt-out signal.
 *   - 1  mint-failed    — creds ARE supplied (ids via env + an inline key) but the key/mint fails.
 * Exit 0 (a real `ghs_` mint) needs a live GitHub App + network, so it is proven by the fake-fetch
 * unit tests in bot-token.unit.test.ts (`mintInstallationToken` returns the token), not here.
 *
 * NEUTRAL FIXTURES: a throwaway org, a bogus inline key — no real org/app-id/pem literal.
 */
import {execFile} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";

const execFileP = promisify(execFile);

// The bin, resolved relative to this test file — repo-relative, no absolute/home path literal.
const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const FIXTURE_REPO = "acme-co/widget"; // throwaway org — not any real org

/** Run `bot-token mint` with a sandboxed HOME + a clean bot-cred env; capture code/stdout/stderr. */
const runMint = async (
	extraEnv: Record<string, string>,
	home: string,
): Promise<{code: number; stdout: string; stderr: string}> => {
	// Strip any ambient bot-cred env so the sandbox is authoritative; HOME points at an empty temp
	// dir so `~/.config/kampus-pipeline/<org>/` does not exist.
	const env: Record<string, string> = {...process.env, HOME: home};
	for (const k of [
		"KAMPUS_PIPELINE_APP_ID",
		"KAMPUS_PIPELINE_INSTALLATION_ID",
		"KAMPUS_PIPELINE_PRIVATE_KEY",
		"KAMPUS_PIPELINE_PRIVATE_KEY_PATH",
		"CLAUDE_PIPELINE_REPO",
	]) {
		delete env[k];
	}
	Object.assign(env, extraEnv);
	try {
		const {stdout, stderr} = await execFileP(
			process.execPath,
			[BIN, "bot-token", "mint", "--repo", FIXTURE_REPO],
			{env},
		);
		return {code: 0, stdout, stderr};
	} catch (e) {
		const err = e as {code?: number; stdout?: string; stderr?: string};
		return {
			code: typeof err.code === "number" ? err.code : 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
		};
	}
};

describe("bot-token mint — exit-code contract (0=ok / 3=not-configured / 1=mint-failed)", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bot-token-exit-"));
	});
	afterEach(() => {
		rmSync(home, {recursive: true, force: true});
	});

	it("no config dir + no id/key env → exit 3 (not-configured), with a clear stderr line", async () => {
		const {code, stdout, stderr} = await runMint({}, home);
		assert.strictEqual(code, 3);
		assert.strictEqual(stdout.trim(), ""); // never a token on the not-configured path
		assert.match(stderr, /no bot configured for this org/i);
		assert.match(stderr, /fall back to the operator token/i);
	});

	it("ids supplied via env + an inline (bogus) key → exit 1 (mint-failed, configured-but-broken)", async () => {
		const {code, stdout} = await runMint(
			{
				KAMPUS_PIPELINE_APP_ID: "123456",
				KAMPUS_PIPELINE_INSTALLATION_ID: "789",
				// A syntactically-bogus PEM: buildAppJwt's createSign throws synchronously, before any
				// network — proving a configured-but-broken bot HARD-FAILS (exit 1), never exit 3.
				KAMPUS_PIPELINE_PRIVATE_KEY:
					"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
			},
			home,
		);
		assert.strictEqual(code, 1);
		assert.strictEqual(stdout.trim(), "");
	});

	it("only ONE id supplied (partial) + no config → exit 1, NOT exit 3 (some intent = configured)", async () => {
		const {code} = await runMint({KAMPUS_PIPELINE_APP_ID: "123456"}, home);
		assert.strictEqual(code, 1);
	});
});
