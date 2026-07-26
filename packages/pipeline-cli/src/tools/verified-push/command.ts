/**
 * The `verified-push` tool — `pipeline-cli verified-push [--cwd DIR] [--remote origin]
 * [--branch NAME] [--set-upstream] [--force-with-lease]`.
 *
 * The sanctioned push path for the pipeline skills (#4213). It pushes AND independently
 * confirms the remote ref, then emits a loud, grep-able TERMINAL LINE on stdout — the one
 * channel that survives both masking layers a bare `git push` dies in (`| tail` eats the
 * exit status; a detached run's output file carries none at all). The decision itself is the
 * pure `decidePush` in `verified-push.ts`; this file is only the git boundary.
 *
 * Two properties of the output are load-bearing, not cosmetic:
 *
 *   - **Everything goes to stdout, and the verdict line is emitted LAST.** Splitting the
 *     report across stdout and stderr would reintroduce the defect under `2>&1 | tail -1`:
 *     inter-stream ordering is not guaranteed, so a stderr line could land after the verdict.
 *     One stream is ordered by construction, so `… | tail -1` is *exactly* the verdict.
 *   - **`Console.log` then `process.exit` does not truncate here.** Node's docs specify that
 *     writes to `process.stdout` are synchronous for pipes on Linux/macOS (asynchronous only
 *     on Windows), which is this platform and CI's; so the verdict cannot be lost to an
 *     unflushed buffer on exit.
 *
 * The ref probe is `git ls-remote`, deliberately: it is a read-only, host-agnostic query
 * over git's own transport, so it needs no REST surface, no auth beyond git's, and no repo
 * literal (ADR 0062). Its tradeoff is honest — if the transport is dead, the probe fails and
 * the verdict is UNKNOWN, which is precisely the loud third outcome, never a false pass.
 *
 * The probe carries a portable bound via `execFileSync`'s own `timeout` option, NOT the
 * `timeout(1)` binary — which is ABSENT on this platform (#3411), where a bare `timeout …`
 * would exit command-not-found and, under masking layer 1, read as success.
 *
 * There is no retry. See the core's docblock for the argument on the record.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	decidePush,
	type PushAttempt,
	type PushFacts,
	type PushVerdict,
	parseLsRemote,
	quoteTail,
	type RefProbe,
} from "./verified-push.ts";

/**
 * A portable Node-level bound on the read-only probe (never `timeout(1)`, #3411). Generous:
 * a timeout resolves to UNKNOWN, so the only cost of being slow to give up is a later loud
 * verdict, while being too eager would manufacture UNKNOWNs out of an ordinary slow network.
 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Well above `execFileSync`'s 1 MB default, because exceeding `maxBuffer` **kills the child**
 * — and the `pre-push` hook runs the whole test suite, whose output blew 1 MB on the very
 * first live run of this verb. A push killed by the buffer limit is a manufactured failure of
 * exactly the kind this verb exists to eliminate, so the limit must never be the thing that
 * decides the verdict.
 */
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * How many trailing lines of each captured stream to quote. The hook's output is thousands of
 * lines; quoting it whole would bury the verdict under a wall the reader must scroll past, and
 * the interesting part of a push (`* [new branch]`, a rejection) is always at the end.
 */
const QUOTED_TAIL_LINES = 40;

interface RunResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
}

/**
 * Run git with its output captured. A non-zero exit, a signal death, and a spawn failure are
 * all absorbed into the returned record — the caller branches on the facts, so no failure is
 * silently lost and none escapes to the E channel.
 */
const runGit = (args: ReadonlyArray<string>, timeoutMs?: number): RunResult => {
	// biome-ignore lint/plugin: total boundary — every git failure mode (non-zero exit, signal death, spawn failure) is absorbed into the returned facts record that the pure core then judges, never the E channel; lifting to Effect.try would only re-collapse to the same record.
	try {
		const stdout = execFileSync("git", [...args], {
			encoding: "utf8",
			// Capture BOTH streams. `execFileSync` inherits stderr by default, which would let
			// git's own output escape onto the parent's stderr — reintroducing exactly the
			// cross-stream interleaving the single-stream report exists to prevent (and printing
			// every git error twice). stdin stays inherited so an interactive credential/SSH
			// prompt behaves as it does under a bare push.
			stdio: ["inherit", "pipe", "pipe"],
			maxBuffer: MAX_BUFFER_BYTES,
			...(timeoutMs === undefined ? {} : {timeout: timeoutMs}),
		});
		return {ok: true, stdout, stderr: "", exitCode: 0, signal: null};
	} catch (cause) {
		const e = cause as {
			stdout?: Buffer | string;
			stderr?: Buffer | string;
			status?: number | null;
			signal?: string | null;
			message?: string;
		};
		return {
			ok: false,
			stdout: String(e.stdout ?? ""),
			// A spawn failure (git absent, cwd gone) has no stderr — surface its message instead,
			// so the UNKNOWN it produces still names what happened.
			stderr: String(e.stderr ?? "") || String(e.message ?? ""),
			exitCode: e.status ?? null,
			signal: e.signal ?? null,
		};
	}
};

/** Read the remote ref back, independently of what the push claimed. */
const probeRef = (cwd: string, remote: string, ref: string): RefProbe => {
	const r = runGit(["-C", cwd, "ls-remote", remote, ref], PROBE_TIMEOUT_MS);
	if (!r.ok) {
		return {
			kind: "failed",
			detail: r.stderr.trim() || `git ls-remote exited ${r.exitCode ?? `signal ${r.signal}`}`,
		};
	}
	const sha = parseLsRemote(r.stdout, ref);
	// A successful ls-remote that lists nothing is POSITIVE evidence the ref is absent — that
	// is the one "no output" this verb is allowed to read as a fact rather than as unknown,
	// because the probe itself exited cleanly.
	return sha === null ? {kind: "absent"} : {kind: "resolved", sha};
};

const cwdFlag = Flag.string("cwd").pipe(
	Flag.withDefault(""),
	Flag.withDescription(
		"the worktree to push from (default: the process cwd). Pass your $WT so a between-calls cwd reset cannot push from the primary checkout.",
	),
);

const remoteFlag = Flag.string("remote").pipe(
	Flag.withDefault("origin"),
	Flag.withDescription("the remote to push to (default: origin)"),
);

const branchFlag = Flag.string("branch").pipe(
	Flag.withDefault(""),
	Flag.withDescription(
		"the branch to push (default: the branch currently checked out in --cwd, re-derived live). A detached HEAD resolves to UNKNOWN and pushes nothing.",
	),
);

const setUpstreamFlag = Flag.boolean("set-upstream").pipe(
	Flag.withDescription("pass -u, for the first push of a new branch"),
);

const forceWithLeaseFlag = Flag.boolean("force-with-lease").pipe(
	Flag.withDescription(
		"pass --force-with-lease, for a repair resubmit whose rebase moved the head",
	),
);

/** Emit the whole report on ONE stream, verdict LAST — see the file docblock for why. */
const report = (lines: ReadonlyArray<string>, verdict: PushVerdict) =>
	Effect.gen(function* () {
		for (const l of lines) yield* Console.log(l);
		yield* Console.log(verdict.terminalLine);
		return yield* Effect.sync(() => process.exit(verdict.exitCode));
	});

const quote = (label: string, text: string): ReadonlyArray<string> =>
	quoteTail(label, text, QUOTED_TAIL_LINES);

const verifiedPush = Command.make(
	"verified-push",
	{
		cwd: cwdFlag,
		remote: remoteFlag,
		branch: branchFlag,
		setUpstream: setUpstreamFlag,
		forceWithLease: forceWithLeaseFlag,
	},
	Effect.fn(function* ({cwd, remote, branch, setUpstream, forceWithLease}) {
		const dir = cwd === "" ? process.cwd() : cwd;

		const notAttempted = (detail: string, lines: ReadonlyArray<string>) =>
			report(lines, decidePush({kind: "not-attempted", detail} satisfies PushFacts));

		const top = runGit(["-C", dir, "rev-parse", "--show-toplevel"]);
		if (!top.ok) {
			return yield* notAttempted(`\`${dir}\` is not a git worktree`, [
				`verified-push: resolving the worktree at ${dir}`,
				...quote("git rev-parse", top.stderr),
			]);
		}
		const worktree = top.stdout.trim();

		// Re-derive the branch LIVE from the worktree unless one was named — the same rule the
		// skill applies at its push sites: never a cached or cross-lane-carried ref.
		const resolvedBranch =
			branch !== "" ? branch : runGit(["-C", dir, "branch", "--show-current"]).stdout.trim();
		if (resolvedBranch === "") {
			return yield* notAttempted("HEAD is detached — there is no branch to push", [
				`verified-push: worktree=${worktree}`,
			]);
		}

		const headRead = runGit(["-C", dir, "rev-parse", "HEAD"]);
		const expectedSha = headRead.stdout.trim();
		if (!headRead.ok || expectedSha === "") {
			return yield* notAttempted("the local HEAD commit could not be resolved", [
				`verified-push: worktree=${worktree} branch=${resolvedBranch}`,
				...quote("git rev-parse HEAD", headRead.stderr),
			]);
		}

		const ref = `refs/heads/${resolvedBranch}`;
		const pushArgs = [
			"-C",
			dir,
			"push",
			...(setUpstream ? ["--set-upstream"] : []),
			...(forceWithLease ? ["--force-with-lease"] : []),
			remote,
			// Explicit src:dst so the push targets exactly the ref that gets probed, regardless of
			// the remote's push.default / refspec configuration.
			`${resolvedBranch}:${ref}`,
		];

		const lines: string[] = [
			`verified-push: worktree=${worktree} branch=${resolvedBranch} head=${expectedSha}`,
			// No `timeout` on the push itself: a slow push must be allowed to finish, and killing
			// it would manufacture exactly the indeterminate state this verb exists to eliminate.
			`verified-push: running \`git ${pushArgs.join(" ")}\``,
		];
		const pushed = runGit(pushArgs);
		lines.push(...quote("push stdout", pushed.stdout), ...quote("push stderr", pushed.stderr));

		const attempt: PushAttempt = {exitCode: pushed.exitCode, signal: pushed.signal};
		lines.push(
			`verified-push: probing the remote ref independently — \`git ls-remote ${remote} ${ref}\``,
		);
		const after = probeRef(dir, remote, ref);
		lines.push(
			`  probe: ${after.kind === "resolved" ? after.sha : after.kind === "absent" ? "ref absent on the remote" : `FAILED — ${after.detail}`}`,
		);

		return yield* report(
			lines,
			decidePush({kind: "attempted", remote, ref, expectedSha, attempt, after}),
		);
	}),
).pipe(
	Command.withDescription(
		"Push a branch AND confirm the remote ref moved, emitting a grep-able PUSH-VERDICT terminal line on stdout (MOVED / NOT-MOVED / UNKNOWN) that survives a `| tail` pipeline and a detached output-file read — the sanctioned replacement for a bare `git push` (#4213)",
	),
);

export const verifiedPushCommand = verifiedPush;
