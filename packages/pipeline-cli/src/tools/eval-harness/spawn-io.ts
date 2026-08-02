/**
 * The OS boundary for the eval runner: the one place in `eval-harness` that starts a process
 * (issue #4676, ADR 0236). Every decision lives in `spawn.ts`; this file only performs.
 *
 * Deliberately synchronous and outside the Effect `E` channel, matching `epic-lock/presence-io.ts`:
 * every failure here is already modelled as a value the pure classifier reads fail-closed (a
 * `SpawnFailed` / `TimedOut` executor result, a `null` transcript path), so lowering it into a typed
 * error would add a channel no caller can act on.
 *
 * A `claude -p` **subprocess is not a `Task` tool call**, so it is outside `spawn-guard`'s
 * `PreToolUse` surface entirely (measured, #4673 §5). That is what lets a run name any model — and
 * it is also why this must never be re-implemented as an in-session Task spawn, which would hard-deny
 * every model outside the guard's allowlist.
 */
import {spawnSync} from "node:child_process";
import {readdirSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {buildClaudeArgs, type Executor, type ExecutorResult, type PlannedRun} from "./spawn.ts";

/**
 * Where `claude` keeps its per-session transcripts. `CLAUDE_CONFIG_DIR` overrides the default
 * per-user config dir (the 2.1.220 binary reads it in 27 places, #4673 §2).
 */
export const claudeDataRoot = (
	env: Readonly<Record<string, string | undefined>> = process.env,
	home: string = homedir(),
): string => {
	const configured = env.CLAUDE_CONFIG_DIR;
	return configured !== undefined && configured !== "" ? configured : join(home, ".claude");
};

/**
 * Find a pinned session's transcript, or `null`.
 *
 * The file is `<data-root>/projects/<cwd-slug>/<session-id>.jsonl`, and the search is a scan of the
 * project dirs rather than a re-derivation of `<cwd-slug>` on purpose: the slug is a lossy
 * flattening of the working directory's separators, so re-deriving it breaks on any path the
 * flattening collapses, and would answer "no transcript" for a run that produced one (#4673 §7).
 */
export const locateTranscript = (sessionId: string, dataRoot = claudeDataRoot()): string | null => {
	const projects = join(dataRoot, "projects");
	let dirs: ReadonlyArray<string>;
	try {
		dirs = readdirSync(projects);
	} catch {
		return null;
	}
	const file = `${sessionId}.jsonl`;
	for (const dir of dirs) {
		const candidate = join(projects, dir, file);
		try {
			readFileSync(candidate, "utf8");
			return candidate;
		} catch {}
	}
	return null;
};

/** A transcript's raw text, or `null` when absent/unreadable — the `TranscriptLoader` `runner.ts` takes. */
export const readTranscript = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/** The CLI version a scorecard is pinned to (#4680), or `null` when it cannot be read. */
export const claudeVersion = (executable = "claude"): string | null => {
	const result = spawnSync(executable, ["--version"], {encoding: "utf8", timeout: 10_000});
	return result.status === 0 ? result.stdout.trim() : null;
};

/**
 * The real executor: run one planned invocation to completion under a stated wall-clock bound.
 *
 * `spawnSync` rather than `execFileSync` because its three outcomes are *return values*, not
 * exceptions — measured on node: a timeout yields `error.code === "ETIMEDOUT"` with `status: null`
 * after SIGTERM, an unresolvable executable yields `ENOENT`, and a normal finish yields a numeric
 * `status`. Mapping them here keeps the classifier total.
 */
export const claudeExecutor = (opts: {
	readonly timeoutMs: number;
	readonly cwd?: string;
	readonly executable?: string;
}): Executor => {
	const executable = opts.executable ?? "claude";
	return (plan: PlannedRun): ExecutorResult => {
		const result = spawnSync(executable, [...buildClaudeArgs(plan)], {
			encoding: "utf8",
			timeout: opts.timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			...(opts.cwd === undefined ? {} : {cwd: opts.cwd}),
		});
		if (result.error !== undefined) {
			const code = (result.error as NodeJS.ErrnoException).code;
			return code === "ETIMEDOUT"
				? {_tag: "TimedOut", boundMs: opts.timeoutMs}
				: {_tag: "SpawnFailed", detail: `${code ?? "unknown"}: ${result.error.message}`};
		}
		if (result.status === null) {
			return {_tag: "SpawnFailed", detail: `killed by signal ${result.signal ?? "unknown"}`};
		}
		return {
			_tag: "Exited",
			code: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	};
};
