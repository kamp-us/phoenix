/**
 * The concurrent-open race, held at the process level — the one property a same-process
 * test cannot show, because `openNamespace` is synchronous and never interleaves with
 * itself in one process.
 *
 * Eight real `scratchpad open` processes are launched at once on ONE session id and ONE
 * slug, differing only by `$CLAUDE_PID`. Before the claim was an exclusive create this
 * exact run returned `0 4 0 6 0 0 4 0` — five of eight each reporting success on the same
 * namespace, which is #3718's silent cross-run read back in reach. Exactly one may win.
 */
import {execFile} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

// Synthetic run identity — never a real machine/session value in a fixture (#4018).
const SESSION = "cccccccc-0000-4000-8000-00000000000c";
const SLUG = "review-doc-3951";
const RACERS = 8;

interface RunResult {
	readonly code: number;
	readonly stdout: string;
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "scratchpad-race-"));
});

afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const open = (pid: string): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "scratchpad", "open", "--slug", SLUG, "--session", SESSION],
			{env: {...process.env, TMPDIR: root, CLAUDE_PID: pid}},
			(error, stdout) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stdout: stdout.trim()});
			},
		);
	});

describe("scratchpad open — concurrent claims on one namespace", () => {
	it("admits exactly one of eight concurrent opens; every other exits 4 (ForeignNamespace)", {
		timeout: 60_000,
	}, async () => {
		const results = await Promise.all(Array.from({length: RACERS}, (_, i) => open(`pid${i}`)));

		const winners = results.filter((result) => result.code === 0);
		assert.strictEqual(
			winners.length,
			1,
			`expected a single winner, got exit codes [${results.map((r) => r.code).join(" ")}]`,
		);
		for (const loser of results.filter((result) => result.code !== 0))
			assert.strictEqual(loser.code, 4, "a loser must be refused as ForeignNamespace, not 0 or 6");

		// The winner owns what it was handed: the surviving stamp names it, and no loser
		// printed a path it could have written into.
		const path = winners[0]?.stdout ?? "";
		assert.strictEqual(path, join(root, "kampus-run", SESSION, SLUG));
		const owner: unknown = JSON.parse(readFileSync(join(path, ".kampus-run-owner"), "utf8"));
		assert.isTrue(
			results.every((result) => result.code === 0 || result.stdout === ""),
			"a refused open must print no path",
		);
		assert.strictEqual((owner as {session: string}).session, SESSION);
	});
});
