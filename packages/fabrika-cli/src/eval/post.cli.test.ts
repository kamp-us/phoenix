/**
 * The end-to-end half of `eval post`: the **exit status and the exact bytes on each channel** a
 * shell caller reads.
 *
 * Only a subprocess proves those, and each `it` costs one cold node+TS load of `bin.ts` — so spawn
 * count is this file's cost (`.patterns/subprocess-test-budget.md`).
 *
 * The three new seats need live PR state, which a CLI tier reaches through a **`gh` shim on PATH**
 * rather than a network: a tiny `sh` dispatcher that serves canned payloads from a temp directory
 * and records the body it was handed. That keeps the assertion honest about what it covers — the
 * verb's own argv, exit status and stream discipline, over a GitHub whose answers the test wrote —
 * while leaving every branch of the decision logic to `./post-verb.unit.test.ts`, where the seam is
 * a substituted layer.
 */
import {execFileSync} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {
	EMPTY_STDIN,
	INCOMPLETE_SCAN,
	MALFORMED_DOCUMENT,
	STALE_HEAD,
	TARGET_ABSENT,
} from "./codes.ts";

const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OTHER_HEAD = "7be402c1d3e5f60718293a4b5c6d7e8f90a1b2c3";
const COMMENT_ID = 9100000001;
const COMMENT_URL = `https://example.test/pull/9041#issuecomment-${COMMENT_ID}`;

const RECORD = [
	`eval: RECORDED @ ${HEAD} — review/skill 1.0 (1/1 cases)`,
	"",
	"```json",
	JSON.stringify(
		{
			sha: HEAD,
			recordedAt: "2026-08-11T06:30:00Z",
			cell: {stage: "review", surface: "skill", model: "claude-opus-4-6"},
			pins: {model: "claude-opus-4-6", cli: "2.1.9", harness: "0.1.0"},
			gradedRuns: 1,
			passedRuns: 1,
			unmeasuredCases: 0,
			passRate: 1,
			cases: [
				{
					caseId: 1,
					verdict: "pass",
					runs: 5,
					passed: 5,
					noVerdict: 0,
					dispersion: 0,
					perRun: ["pass", "pass", "pass", "pass", "pass"],
				},
			],
		},
		null,
		2,
	),
	"```",
	"",
].join("\n");

/**
 * The dispatcher, in `sh` rather than node: an extensionless entry file's module system is a
 * platform detail this test has no business depending on. It only serves files and captures the
 * body, so every payload stays authored in the test.
 */
const SHIM = `#!/bin/sh
for a in "$@"; do
  case "$a" in body=*) printf '%s' "\${a#body=}" > "$GH_STATE/posted.txt" ;; esac
done
case "$*" in
  *"--method POST"*) cat "$GH_STATE/create.json" ;;
  *"pulls/9041"*)
    if [ -f "$GH_STATE/pull-404" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    cat "$GH_STATE/pull.json" ;;
  *"issues/9041/comments"*) cat "$GH_STATE/comments.json" ;;
  *"issues/comments/"*) cat "$GH_STATE/readback.json" ;;
  *) echo "unscripted: $*" >&2; exit 1 ;;
esac
`;

interface Scripted {
	readonly head?: string;
	readonly state?: string;
	readonly declaredComments?: number;
	readonly comments?: ReadonlyArray<{id: number; body: string}>;
	readonly absent?: boolean;
	readonly readbackBody?: string;
}

interface Shim {
	readonly dir: string;
	readonly state: string;
}

const shim = (scripted: Scripted): Shim => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-post-cli-"));
	const state = join(dir, "state");
	writeFileSync(join(dir, "gh"), SHIM);
	chmodSync(join(dir, "gh"), 0o755);
	mkdirSync(state, {recursive: true});
	if (scripted.absent === true) writeFileSync(join(state, "pull-404"), "");
	writeFileSync(
		join(state, "pull.json"),
		JSON.stringify({
			number: 9041,
			state: scripted.state ?? "open",
			head: {sha: scripted.head ?? HEAD},
			base: {ref: "main"},
			body: "does a thing",
			changed_files: 2,
			comments: scripted.declaredComments ?? 0,
		}),
	);
	writeFileSync(
		join(state, "comments.json"),
		JSON.stringify(
			(scripted.comments ?? []).map((row) => ({
				id: row.id,
				user: {login: "kampus-bot"},
				created_at: "2026-08-11T00:00:00Z",
				updated_at: "2026-08-11T00:00:00Z",
				body: row.body,
			})),
		),
	);
	writeFileSync(
		join(state, "create.json"),
		JSON.stringify({id: COMMENT_ID, html_url: COMMENT_URL}),
	);
	writeFileSync(
		join(state, "readback.json"),
		JSON.stringify({body: scripted.readbackBody ?? RECORD}),
	);
	return {dir, state};
};

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `FABRIKA_SKIP_INFER` pins the invocation to *this* copy rather than whichever install a root pins. */
const fabrika = (args: ReadonlyArray<string>, stdin: string, on?: Shim): Run => {
	const env: Record<string, string | undefined> = {
		...process.env,
		FABRIKA_SKIP_INFER: "1",
		CLAUDE_PIPELINE_REPO: "o/r",
	};
	if (on !== undefined) {
		env.PATH = `${on.dir}:${process.env.PATH ?? ""}`;
		env.GH_STATE = on.state;
	}
	try {
		const stdout = execFileSync(process.execPath, [BIN, ...args], {
			encoding: "utf8",
			env,
			input: stdin,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {code: 0, stdout, stderr: ""};
	} catch (err) {
		const failure = err as {status?: number; stdout?: string; stderr?: string};
		return {code: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? ""};
	}
};

const post = (stdin: string, on?: Shim): Run => fabrika(["eval", "post", "9041"], stdin, on);

describe("fabrika eval post, end to end", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	it("refuses an empty pipe on the stdin seat, with NOTHING on stdout", () => {
		const run = post("");
		expect(run.code).toBe(EMPTY_STDIN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("no record on stdin");
	});

	it("refuses bytes that are not an eval record on the malformed seat", () => {
		const run = post("just some prose\n");
		expect(run.code).toBe(MALFORMED_DOCUMENT);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("does not read as an eval record");
	});

	it("posts the record verbatim and prints the answer line", () => {
		const on = shim({});
		const run = post(RECORD, on);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(`posted\tRECORDED\t${HEAD}\treview/skill\tcreated\t${COMMENT_URL}\n`);
		expect(readFileSync(join(on.state, "posted.txt"), "utf8")).toBe(RECORD);
	});

	it("refuses a record bound to a head the PR has left, on STALE_HEAD", () => {
		const run = post(RECORD, shim({head: OTHER_HEAD}));
		expect(run.code).toBe(STALE_HEAD);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("never re-bind");
	});

	it("refuses a provably short comment sweep on INCOMPLETE_SCAN", () => {
		const run = post(RECORD, shim({declaredComments: 3}));
		expect(run.code).toBe(INCOMPLETE_SCAN);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("received 0 of 3 declared comments");
	});

	it("refuses an absent PR on TARGET_ABSENT", () => {
		const run = post(RECORD, shim({absent: true}));
		expect(run.code).toBe(TARGET_ABSENT);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("not found in o/r");
	});
});
