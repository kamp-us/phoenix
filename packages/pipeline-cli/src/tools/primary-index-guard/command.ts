/**
 * The `primary-index-guard` tool — `pipeline-cli primary-index-guard pre-commit`.
 *
 * The BLOCKING §CP promotion of the read-only `@kampus/primary-index-tripwire` (PR #2783). Wired as
 * git's own `pre-commit` hook (`lefthook.yml`), it fires as a commit carrying the #2778
 * mass-staged-deletion signature is CREATED on the PRIMARY checkout — the one caller-agnostic choke
 * point before a push can fast-forward that control-plane mass deletion onto `origin/main` (the
 * residual vector #2783 named: `ref-guard` allows a fast-forward, `main-sync` only catches its own
 * path). The read-only `record` leg stays alongside this block: record for attribution, refuse for
 * containment.
 *
 * Safe by construction (the pure `decidePrimaryIndexCommit` is the first enforcement line, this
 * command's flow is the second): DETECTION + REFUSAL only — it reads staged state read-only
 * (`git diff --cached`) and aborts the commit by exit code; it NEVER mutates git or the tree (no
 * `git reset`, no `worktree remove`), so evaluating the guard can never itself corrupt the checkout.
 *
 * Fail-CLOSED on the guard's own refusal, fail-OPEN when the CLI can't RUN — mirrors `ref-guard`:
 * a not-yet-installed / stripped-PATH env (#787) or a bin remediation exit (#1798) must NOT abort
 * every commit, so a deliberate refuse carries the DEDICATED {@link REFUSE_EXIT_CODE} (3); the
 * `lefthook.yml` wrapper aborts the commit only on code 3 and swallows every other non-zero to a
 * clean allow.
 */
import {execFileSync} from "node:child_process";
import {Console, Effect, Option, Path} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {appendRecord, defaultLogPath, parseNameStatus} from "./index.ts";
import {decidePrimaryIndexCommit, MASS_DELETION_BLOCK_THRESHOLD} from "./primary-index-guard.ts";

/** The dedicated refuse exit code — see `ref-guard`'s `REFUSE_EXIT_CODE`; the lefthook wrapper aborts only on this. */
export const REFUSE_EXIT_CODE = 3;

const runGit = (args: ReadonlyArray<string>): {ok: boolean; stdout: string} => {
	// biome-ignore lint/plugin: best-effort git shell — a non-zero exit is fully absorbed into {ok:false} the caller branches on, never the E channel; a total helper, not Effect-cosplay.
	try {
		const stdout = execFileSync("git", [...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return {ok: true, stdout};
	} catch {
		return {ok: false, stdout: ""};
	}
};

/** The staged deletions as `git diff --cached --name-status --diff-filter=D` (read-only). */
const stagedDeletions = (): string => {
	const r = runGit(["diff", "--cached", "--name-status", "--diff-filter=D"]);
	return r.ok ? r.stdout : "";
};

/**
 * `true` iff this commit fires against the shared PRIMARY checkout — the per-tree git-dir equals the
 * shared git-common-dir on the primary, differs in a linked worktree (the same signal write-code's
 * worktree preflight and ref-guard use). Indeterminate ⇒ `false` (fail-OPEN: a checkout we cannot
 * prove is the primary is not blocked, so a worktree agent is never false-refused).
 *
 * Path normalization goes through the Effect `Path` seam (over the bin's `NodeServices.layer`);
 * git IO stays a raw read-only subprocess (the subprocess seam is a separate migration —
 * `.patterns/effect-platform-access.md` / `.patterns/effect-process-cli-shell.md`).
 */
const resolvePrimaryCheckout = Effect.fn(function* () {
	const path = yield* Path.Path;
	const gd = runGit(["rev-parse", "--path-format=absolute", "--git-dir"]);
	const cd = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!gd.ok || !cd.ok) return false;
	const gitDir = gd.stdout.trim();
	const commonDir = cd.stdout.trim();
	if (gitDir === "" || commonDir === "") return false;
	return path.resolve(gitDir) === path.resolve(commonDir);
});

const thresholdFlag = Flag.integer("threshold").pipe(
	Flag.withDefault(MASS_DELETION_BLOCK_THRESHOLD),
	Flag.withDescription("min control-plane staged deletions to REFUSE the primary commit"),
);

const logFlag = Flag.string("log").pipe(
	Flag.optional,
	Flag.withDescription(
		"attribution log path (default: $PRIMARY_INDEX_TRIPWIRE_LOG or a temp file)",
	),
);

const preCommit = Command.make(
	"pre-commit",
	{threshold: thresholdFlag, log: logFlag},
	Effect.fn(function* ({threshold, log}) {
		const decision = decidePrimaryIndexCommit({
			onPrimaryCheckout: yield* resolvePrimaryCheckout(),
			staged: parseNameStatus(stagedDeletions()),
			cwd: process.cwd(),
			agentType: process.env.CLAUDE_CODE_AGENT ?? "",
			sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "",
			worktreeRoot: process.env.WORKTREE_ROOT ?? "",
			threshold,
			at: new Date().toISOString(),
		});
		if (decision.kind === "allow") return; // silent clean allow (a pre-commit hook that exits 0)

		// Record the blocked attempt through the SAME out-of-repo log the read-only tripwire uses,
		// then abort the commit with the dedicated refuse code. Never mutates git or the tree.
		const logPath = Option.getOrElse(log, defaultLogPath);
		appendRecord(logPath, `${JSON.stringify({...decision.record, blocked: true})}\n`);
		yield* Console.error(`primary-index-guard REFUSED (fail-closed): ${decision.reason}`);
		return yield* Effect.sync(() => process.exit(REFUSE_EXIT_CODE));
	}),
).pipe(
	Command.withDescription(
		"git pre-commit hook: REFUSE a commit carrying the #2778 mass control-plane staged-deletion signature on the PRIMARY checkout — caller-agnostic, fail-closed (#2784)",
	),
);

export const primaryIndexGuardCommand = Command.make("primary-index-guard").pipe(
	Command.withSubcommands([preCommit]),
	Command.withDescription(
		"Blocking primary-index staging guard — refuse a mass control-plane staged deletion committed on the shared primary checkout (#2784, promotes the #2783 read-only tripwire)",
	),
);
