/**
 * The `ref-guard` tool — `pipeline-cli ref-guard reference-transaction <state>`.
 *
 * The caller-agnostic, fail-closed guardrail that refuses a DIVERGING ref-move on the
 * shared primary checkout's `refs/heads/main` (issue #2143). Wired as git's own
 * `reference-transaction` hook (via `lefthook.yml`), so it fires for EVERY ref update
 * regardless of caller — agent Bash, harness worktree machinery, a manually-run
 * command, or another git hook. This is the boundary a `PreToolUse` Bash hook (the
 * #1571 `worktree-guard` bash-pin) structurally cannot reach: that guard only arms for
 * a `$WORKTREE_ROOT` subagent and only matches its `HEAD_MOVING` set, while the #2143
 * force-move was a bare ref-move by the orchestrator/PULLER role outside the agent
 * Bash tool-call path entirely.
 *
 * The `reference-transaction` hook contract (git): it takes exactly one argument — the
 * transaction state (`prepared` | `committed` | `aborted`) — and reads on stdin one line
 * per queued update, `<old-oid> SP <new-oid> SP <ref-name>`. The exit status is honored
 * ONLY in the `prepared` state: a non-zero exit there aborts the whole transaction. So
 * this command evaluates + can refuse only in `prepared`; `committed`/`aborted` (and any
 * other state) drain stdin and no-op (exit 0), since a refusal there is ignored anyway.
 *
 * Safe by construction (the pure core `ref-guard.ts` is the first enforcement line, this
 * command's flow is the second):
 *   1. The pure `decideRefUpdate` allows every non-`refs/heads/main` update untouched, and
 *      on `refs/heads/main` allows only a fast-forward of `origin/main`; a non-ff divergence
 *      (or a delete) REFUSES. The legitimate PULLER `merge --ff-only origin/main` is a
 *      fast-forward, so it always passes.
 *   2. The origin facts are gathered read-only (`git rev-parse origin/main` +
 *      `git merge-base --is-ancestor origin/main <newOid>`) with `execFileSync` (mirrors
 *      `main-sync` / the `worktree-guard` reaper) — no mutation, so evaluating the guard
 *      never itself moves a ref.
 *
 * Fail-open on infrastructure absence (the git boundary can't gather facts), fail-CLOSED on
 * a guarded-ref divergence: an unresolvable `origin/main` allows the update (nothing to
 * diverge from — a fresh clone before the first fetch), but an ancestry probe that FAILS is
 * passed as `originIsAncestorOfNew=false`, which on `refs/heads/main` refuses (cannot prove a
 * fast-forward ⇒ treat as divergence).
 */
import {execFileSync} from "node:child_process";
import {Console, Effect} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command} from "effect/unstable/cli";
import {
	type CheckoutContext,
	decideHeadDetach,
	decideRefUpdate,
	decideTransaction,
	GUARDED_REF,
	type OriginFacts,
	type RefUpdate,
	ZERO_OID,
} from "./ref-guard.ts";

/**
 * The DEDICATED refuse exit code — deliberately NOT 1. The `lefthook.yml`
 * reference-transaction wrapper aborts the git transaction ONLY on this exact code, and
 * fail-OPENs (allows) on every other non-zero. This disambiguates a real guard refusal
 * from an infrastructural CLI failure that also exits 1 — `bin.ts`'s unlinked-dependency
 * remediation exits 1 on a fresh/partial checkout (#1798), and a fail-closed-on-1 hook
 * would then abort every ref transaction repo-wide, exactly the #1050/#787 fail-open
 * invariant this must not break. A unique code keeps refuse fail-CLOSED and every other
 * failure fail-OPEN.
 */
export const REFUSE_EXIT_CODE = 3;

/** A stdin read that rejected — absorbed to "" so the guard evaluates no updates (fail-open). */
class StdinUnreadable extends Schema.TaggedErrorClass<StdinUnreadable>()("StdinUnreadable", {
	cause: Schema.Unknown,
}) {}

/** Read the whole hook stdin (may be empty); an unreadable stdin is absorbed to "". */
const readStdin = (): Effect.Effect<string> =>
	Effect.tryPromise({
		try: async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
			return Buffer.concat(chunks).toString("utf8");
		},
		catch: (cause) => new StdinUnreadable({cause}),
	}).pipe(Effect.orElseSucceed(() => ""));

/**
 * Parse git's `reference-transaction` stdin — one `<old-oid> SP <new-oid> SP <ref-name>`
 * line per queued update. Blank lines and malformed lines (not exactly three
 * whitespace-separated fields) are skipped; the guard evaluates only well-formed updates.
 */
const parseUpdates = (stdin: string): ReadonlyArray<RefUpdate> => {
	const updates: RefUpdate[] = [];
	for (const line of stdin.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const parts = trimmed.split(/\s+/);
		if (parts.length !== 3) continue;
		const [oldOid, newOid, refName] = parts as [string, string, string];
		updates.push({oldOid, newOid, refName});
	}
	return updates;
};

const runGit = (args: ReadonlyArray<string>): {ok: boolean; stdout: string} => {
	// biome-ignore lint/plugin: best-effort probe — a failed git invocation is fully absorbed into {ok:false} (a fail-safe sentinel the caller reads), never the E channel; lifting to Effect.try to re-collapse to the same sentinel is noise, not the failure-modeling no-raw-try-catch targets.
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

/**
 * Resolve `origin/main` to an OID, or `null` when the remote-tracking ref is absent (a
 * fresh clone before the first fetch). `null` is the fail-OPEN sentinel the core reads as
 * "nothing to diverge from".
 */
const resolveOriginMain = (): string | null => {
	const r = runGit(["rev-parse", "--verify", "--quiet", "origin/main"]);
	if (!r.ok) return null;
	const oid = r.stdout.trim();
	return oid === "" ? null : oid;
};

/**
 * `true` iff `origin/main` is an ancestor of (or equal to) `newOid` — a fast-forward.
 * `git merge-base --is-ancestor A B` exits 0 when A is an ancestor of B, 1 when not; any
 * OTHER failure (bad OID, git error) is indeterminate and returns `false` (fail-safe: on
 * the guarded ref the core refuses when a fast-forward can't be proven).
 */
const originIsAncestorOf = (newOid: string): boolean => {
	// biome-ignore lint/plugin: best-effort probe — an indeterminate merge-base (bad OID/git error) is absorbed into false (fail-safe: the core refuses when a fast-forward can't be proven), never the E channel; this is a total predicate, not Effect-cosplay.
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", "origin/main", newOid], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
};

/**
 * `true` iff this reference-transaction is firing against the shared PRIMARY checkout, resolved
 * exactly as `write-code`'s worktree preflight does: the per-tree git-dir equals the shared
 * git-common-dir on the primary, and differs in a linked worktree. Both are read with
 * `--path-format=absolute` so the comparison is over identically-normalized absolute paths.
 * An indeterminate resolution (either rev-parse fails/empty) returns `false` — fail-OPEN, so a
 * HEAD detach we cannot prove is on the primary is allowed and a worktree agent is never
 * false-refused (mirrors the guard's fail-open-on-infrastructure-absence posture).
 */
const resolvePrimaryCheckout = (): boolean => {
	const gd = runGit(["rev-parse", "--path-format=absolute", "--git-dir"]);
	const cd = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!gd.ok || !cd.ok) return false;
	const gitDir = gd.stdout.trim();
	const commonDir = cd.stdout.trim();
	if (gitDir === "" || commonDir === "") return false;
	return gitDir === commonDir;
};

const stateArg = Argument.string("state").pipe(
	Argument.withDescription(
		"the reference-transaction state: prepared | committed | aborted (git passes this). Only 'prepared' can refuse.",
	),
);

const referenceTransaction = Command.make(
	"reference-transaction",
	{state: stateArg},
	Effect.fn(function* ({state}) {
		const stdin = yield* readStdin();
		const updates = parseUpdates(stdin);

		// Exit status is honored ONLY in 'prepared' (git contract) — a refuse in any other
		// state is ignored, so drain and no-op. This also means the guard never blocks a
		// 'committed'/'aborted' notification.
		if (state !== "prepared") return;

		// Evaluate only guarded-ref updates against origin facts; every other update is an
		// out-of-scope allow the core returns without consulting origin (no needless git IO).
		const guardsMain = updates.some((u) => u.refName === GUARDED_REF && u.newOid !== ZERO_OID);
		const originMainOid = guardsMain ? resolveOriginMain() : null;

		const facts = (update: RefUpdate): OriginFacts => {
			if (update.refName !== GUARDED_REF || update.newOid === ZERO_OID) {
				return {originMainOid: null, originIsAncestorOfNew: false};
			}
			return {
				originMainOid,
				originIsAncestorOfNew: originMainOid !== null && originIsAncestorOf(update.newOid),
			};
		};

		// Two orthogonal concerns fold into one transaction verdict: the per-update
		// refs/heads/main divergence guard (#2143), and the batch-level HEAD-detach guard on
		// the primary checkout (#2270 — a detach moves HEAD, not refs/heads/main, so it is a
		// separate decision over the whole batch). Any refuse aborts the transaction.
		const checkout: CheckoutContext = {isPrimaryCheckout: resolvePrimaryCheckout()};
		const verdict = decideTransaction([
			decideHeadDetach(updates, checkout),
			...updates.map((u) => decideRefUpdate(u, facts(u))),
		]);

		if (verdict.kind === "refuse") {
			// ADR 0092 "emit what you scanned": name the guarded ref + why before aborting.
			yield* Console.error(`ref-guard: ${verdict.reason}`);
			// The dedicated refuse code (not 1) — see REFUSE_EXIT_CODE: the hook aborts the
			// transaction only on this code, fail-opening on an infra CLI failure that exits 1.
			return yield* Effect.sync(() => process.exit(REFUSE_EXIT_CODE));
		}
		// allow: silent success (a hook that exits 0 with no stdout is a clean allow).
	}),
).pipe(
	Command.withDescription(
		"git reference-transaction hook: refuse a DIVERGING refs/heads/main ref-move on the shared primary checkout (non-fast-forward of origin/main) — caller-agnostic, fail-closed (#2143)",
	),
);

export const refGuardCommand = Command.make("ref-guard").pipe(
	Command.withSubcommands([referenceTransaction]),
	Command.withDescription(
		"Caller-agnostic ref-transaction guard — refuse a diverging refs/heads/main move on the shared primary checkout (#2143)",
	),
);
