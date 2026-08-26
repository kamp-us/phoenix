/**
 * Two real processes racing one lane ledger — the probabilistic half of #5994's evidence.
 *
 * The deterministic half (a scripted held lock refuses CONCURRENT_WRITE with the log untouched)
 * lives in [`append-lock.unit.test.ts`](append-lock.unit.test.ts). What that tier cannot prove is
 * that two live processes launched against the same ledger actually interleave badly enough for
 * the guard to matter, and that when they do, the outcome stays coherent: every appended line
 * parses, every exit is one of the three legal seats (won / machine-refused / lock-refused), and a
 * machine-refused event never reaches the log.
 *
 * The children run this checkout's own `src/bin.ts` under node's type stripping — no build step on
 * the gate path. Collision frequency depends on real scheduling, so the invariants are asserted
 * across repeated pairs rather than trusting one lucky race.
 */
import {execFile} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {beforeAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));
const exec = promisify(execFile);

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const spawnTransition = async (root: string): Promise<Run> => {
	try {
		const {stdout} = await exec(
			process.execPath,
			[
				"--experimental-strip-types",
				BIN,
				"lane",
				"transition",
				"42",
				"WIP",
				"--root",
				join(root, ".fabrika", "lanes"),
			],
			{cwd: root, env: process.env},
		);
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {code?: number; stdout?: string; stderr?: string};
		return {code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

describe("two concurrent lane writers stay coherent (#5994)", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	const root = join(mkdtempSync(join(tmpdir(), "lane-race-")), "checkout");
	const lanesRoot = join(root, ".fabrika", "lanes");
	const logPath = join(lanesRoot, "42", "events.jsonl");

	beforeAll(() => {
		// The ground guard needs a repo marker; `.fabrika` itself is one (#6212).
		mkdirSync(join(root, ".fabrika"), {recursive: true});
		mkdirSync(join(lanesRoot, "42"), {recursive: true});
		writeFileSync(join(lanesRoot, "42", "workflow.json"), coderTemplateText());
	});

	it("a raced pair leaves the ledger parseable and never records a refused event twice", async () => {
		for (let pair = 0; pair < 6; pair++) {
			const before = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";

			const [a, b] = await Promise.all([spawnTransition(root), spawnTransition(root)]);
			const runs = [
				{...a, name: "A"},
				{...b, name: "B"},
			];

			for (const r of runs) {
				// 0 won · 12 the machine refused it against the true state · 40 the lock said wait longer.
				expect([0, 12, 40]).toContain(r.code);
				if (r.code === 0) expect(() => JSON.parse(r.stdout)).not.toThrow();
			}
			// A fresh lane accepts WIP exactly once: both writers cannot both win it.
			expect([a.code, b.code].filter((c) => c === 0).length).toBeLessThanOrEqual(1);

			// No torn or half-written lines: every recorded line parses, and nothing was lost.
			const after = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
			for (const line of after.split("\n").filter(Boolean)) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
			// The losing writer's refusal left the log byte-identical to before its attempt.
			if ([a.code, b.code].every((c) => c !== 0)) {
				expect(after).toBe(before);
			}
		}

		const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(1);
	});
});
