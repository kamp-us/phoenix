/**
 * The `session` subcommand's flag surface (#3445): the seam standup/bind.ts (the producer) bakes
 * `--instance <uuid>` into every engine's argv, so `bin.ts session` (the consumer) MUST declare that
 * flag or Effect-CLI rejects it and every engine session dies at parse before serving. Drives the
 * real bin as a subprocess (the same `execFile` idiom worktree-guard's command test uses) — a
 * declared flag is listed in `--help` and parses, an undeclared one is neither.
 */
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (...args: readonly string[]): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, ...args], (error, stdout, stderr) => {
			const code =
				error && typeof (error as {code?: unknown}).code === "number"
					? (error as {code: number}).code
					: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("bin.ts — the session subcommand declares --instance (#3445)", () => {
	it("session --help lists --instance, so the flag bind.ts bakes parses instead of aborting", async () => {
		const {code, stdout} = await run("session", "--help");
		assert.strictEqual(code, 0, "session --help exits 0");
		assert.match(
			stdout,
			/--instance/,
			"the --instance flag is declared (bind.ts's producer now has a consumer)",
		);
		// the pre-existing flags still render — the additive change didn't drop them.
		assert.match(stdout, /--role/, "the --role flag is still declared");
		assert.match(stdout, /--project-root/, "the --project-root flag is still declared");
	}, 30_000);
});
