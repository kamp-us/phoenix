/**
 * The lane ledger's write lock — the serialization concurrent shells are owed.
 *
 * Until shells recorded their own terminals, a lane had exactly one writer and the
 * check-then-act window between `loadLane` and `appendText` never opened. An epic run's parallel
 * phase has several shells alive at once, so the window is live now: two writers can both validate
 * against the same fold and both append, and the loser records an event the machine would have
 * refused against the state that actually existed when its bytes landed. The corruption is silent
 * and permanent — the fold is the lane's only state.
 *
 * The primitive is an atomic `mkdir` on a sidecar directory (`events.lock` beside `events.jsonl`):
 * directory creation either lands whole or fails `AlreadyExists`, so exactly one writer holds it.
 * Every verb that appends to a lane log takes the lock around its **entire** load → fold → validate
 * → append section, so validation always runs against the bytes that are about to receive the
 * write. A writer that finds the lock held waits within its budget; on budget exhaustion it refuses
 * {@link CONCURRENT_WRITE} — a distinct seat from an ordinary machine refusal, because the remedy
 * differs: retry this same event, versus pick a different one.
 *
 * **A crashed holder must not brick the lane.** A process killed between acquire and release would
 * otherwise leave the sidecar forever, so a lock whose directory mtime is older than
 * {@link STALE_LOCK_MS} is stolen on sight. Anything newer is presumed alive; waiting is the honest
 * answer.
 *
 * **The two durations are one setting, which is why only one of them is written down.** A waiter
 * gives up at its budget and a lock only becomes stealable at the stale horizon, so a budget
 * shorter than the horizon makes the horizon unreachable: every writer arriving inside the
 * difference refuses {@link CONCURRENT_WRITE} against a lock nobody holds, and nothing waits the
 * window out. That gap shipped — a 5s budget against a 60s horizon left an orphaned lock
 * un-stealable for 55 seconds, and a shell lost its terminal to it twice seconds apart. So the
 * horizon is the knob and the default budget is **derived** from it: raise or lower
 * {@link STALE_LOCK_MS} and the budget moves with it, because the one thing a reader must not be
 * able to do is tune one of them alone.
 * `FABRIKA_LANE_LOCK_BUDGET_MS` still overrides the budget on purpose — a caller asking to refuse
 * fast is asking not to reach the horizon at all.
 */
import {Effect, type FileSystem, Option, type Path, Result} from "effect";
import {CONCURRENT_WRITE} from "./codes.ts";
import {WORKFLOW_FILE} from "./store.ts";

/** The sidecar directory a holding writer creates inside the lane directory. */
export const LOCK_DIR_NAME = "events.lock";

/**
 * A held lock older than this is presumed crashed, not slow, and is stolen.
 *
 * It is a margin over how long a legitimate holder can take, and that is bounded only because **no
 * caller reads the board under the lock**: every appending verb judges against its board read
 * first, then takes the lock and re-loads, re-folds and appends, so the hold is local IO measured
 * in milliseconds. Ten seconds is two orders of magnitude over that — the honest reading of "this
 * process is gone", inside a wait a shell can afford.
 *
 * The bound is therefore a property of the callers, and it is the one thing a new caller can break:
 * a single `yield*` on an HTTP read inside {@link withLedgerLock} puts the hold on the network's
 * clock instead, where one stalled exchange costs `DEFAULT_HTTP_TIMEOUT_SECONDS` (60s in
 * `io/gh-api.ts`) and a paginated read costs a multiple of it. A holder that slow is read as
 * crashed and has its live lock stolen, which is the silent double-append the lock exists to
 * refuse. `lane settle` shipped exactly that shape and was moved out.
 */
const STALE_LOCK_MS = 10_000;

/** Poll cadence while waiting for a held lock. */
const POLL_MS = 50;

/**
 * How long a writer waits for a held lock before refusing rather than writing blind — the stale
 * horizon plus enough polls to notice and steal, never a second number to keep in step by hand.
 *
 * The grace matters because the two clocks start apart: a waiter arriving the instant a lock was
 * created reaches the horizon a full {@link STALE_LOCK_MS} later and still needs a poll to act on
 * it. A budget equal to the horizon would expire in that gap.
 */
const DEFAULT_LOCK_BUDGET_MS = STALE_LOCK_MS + 20 * POLL_MS;

/**
 * The budget is an operations surface, not just a constant: a caller that would rather refuse fast
 * (a test, an interactive shell) sets `FABRIKA_LANE_LOCK_BUDGET_MS` and every verb honors it.
 */
const lockBudgetMs = (): number => {
	const raw = process.env.FABRIKA_LANE_LOCK_BUDGET_MS;
	const parsed = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCK_BUDGET_MS;
};

export interface LockRefusal {
	readonly _tag: "Locked";
	readonly lockDir: string;
	readonly reason: string;
}

/**
 * What one `mkdir` attempt proved. `held` and `absent` are opposite answers taking opposite
 * remedies: wait for the holder, versus stop — no lock ever appears inside a directory that is not
 * there.
 */
export type LockAttempt = "acquired" | "held" | "absent";

const acquireOnce = (
	fs: FileSystem.FileSystem,
	lockDir: string,
): Effect.Effect<LockAttempt, never> =>
	Effect.gen(function* () {
		const made = yield* Effect.result(fs.makeDirectory(lockDir, {recursive: false}));
		if (Result.isSuccess(made)) return "acquired";
		// A non-recursive mkdir fails two ways that mean opposite things, so the reason decides it:
		// EEXIST (`AlreadyExists`) is the atomic-mkdir race — someone holds the lock — while ENOENT
		// (`NotFound`) is the lane directory itself missing, which no amount of waiting fixes. The
		// errno mapping is `@effect/platform-node-shared`'s `internal/utils.ts`.
		return made.failure.reason._tag === "NotFound" ? "absent" : "held";
	});

const removeLock = (fs: FileSystem.FileSystem, lockDir: string): Effect.Effect<void, never> =>
	Effect.ignore(fs.remove(lockDir, {recursive: true}));

/**
 * Take a lock whose holder is presumed dead, answering whether a retry is now worth making.
 *
 * **The removal is the steal.** Reading the mtime only reaches a verdict; the sidecar is still
 * there, so a re-`mkdir` that followed a bare verdict would fail `AlreadyExists` against the very
 * directory being stolen and the waiter would poll to its deadline against a lock nobody holds.
 * A `stat` that fails or reports no mtime is UNKNOWN, and UNKNOWN never steals.
 *
 * Losing the re-`mkdir` to another waiter is not a failure of this function: the caller reads
 * `held` and keeps polling, which is the right answer once someone else holds it.
 */
const stealIfStale = (fs: FileSystem.FileSystem, lockDir: string): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const probed = yield* Effect.result(fs.stat(lockDir));
		if (Result.isFailure(probed)) return false;
		const mtime = probed.success.mtime;
		if (Option.isNone(mtime)) return false;
		if (Date.now() - mtime.value.getTime() <= STALE_LOCK_MS) return false;
		yield* removeLock(fs, lockDir);
		return true;
	});

/**
 * Wait for and hold the lane's write lock. `acquired` means this writer holds it — release is the
 * caller's duty, best-effort via {@link releaseLedgerLock}. `held` means the budget ran out with the
 * lock still held elsewhere, and `absent` that the directory the lock would live in is not there.
 * Nothing was written anywhere on either refusal.
 *
 * `absent` returns on the first attempt instead of polling: waiting out the budget for a directory
 * to appear reports contention that can never clear, which is what sent a shipper into a retry loop
 * against a lane nobody had opened.
 */
export const acquireLedgerLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	budgetMs: number = lockBudgetMs(),
): Effect.Effect<LockAttempt, never> =>
	Effect.gen(function* () {
		const deadline = Date.now() + budgetMs;
		while (true) {
			const attempt = yield* acquireOnce(fs, lockDir);
			if (attempt !== "held") return attempt;
			if (yield* stealIfStale(fs, lockDir)) {
				const stolen = yield* acquireOnce(fs, lockDir);
				if (stolen !== "held") return stolen;
			}
			if (Date.now() >= deadline) return "held";
			yield* Effect.sleep(`${POLL_MS} millis`);
		}
	});

/** Best-effort release: a failed removal leaves the lock to be stolen as stale, never retried here. */
export const releaseLedgerLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
): Effect.Effect<void, never> => removeLock(fs, lockDir);

/**
 * Run one verb body inside the lane's write lock. The inner effect sees the bytes as they are when
 * the lock is already held, so its validation cannot race another writer's append. Release runs on
 * every exit, refusal included.
 *
 * **The body is local IO only.** A board read belongs before this call, with the body re-loading and
 * re-deriving under the lock — the shape every appending verb takes, and what {@link STALE_LOCK_MS}
 * is a margin over.
 *
 * Two refusals, two seats. `onLocked` is {@link CONCURRENT_WRITE}'s — "retry this same event once
 * the holder clears" — and it belongs only to a lock a live writer holds. `onAbsent` is the lane's
 * own absence, checked **before** the lock precisely because the lock sits inside the lane
 * directory: a verb that takes the lock first can never reach its own `loadLane`, so an unopened
 * lane answered "another writer holds it" forever. Nothing here creates the lane directory —
 * a ledger nobody booted would spend the proven absence `operate` boots on.
 */
export const withLedgerLock = <A, R>(
	deps: {
		readonly fs: FileSystem.FileSystem;
		readonly path: Path.Path;
		/** The lane directory the log lives in — the lock sits beside the log, inside it. */
		readonly dir: string;
		/** The invoking verb's label, quoted in the lock-timeout refusal. */
		readonly verb: string;
	},
	inner: Effect.Effect<A, never, R>,
	refusals: {
		/** No lane at `dir` — the caller's own "no lane" answer, never the lock's. */
		readonly onAbsent: (dir: string) => A;
		readonly onLocked: (lockDir: string, reason: string) => A;
	},
): Effect.Effect<A, never, R> =>
	Effect.gen(function* () {
		const lockDir = deps.path.join(deps.dir, LOCK_DIR_NAME);
		// The same document `loadLane` proves a lane absent by, so "no lane" means one thing here and
		// downstream. An unprobeable path is UNKNOWN rather than absent: it falls through to the lock.
		const booted = yield* Effect.result(deps.fs.exists(deps.path.join(deps.dir, WORKFLOW_FILE)));
		if (Result.isSuccess(booted) && !booted.success) return refusals.onAbsent(deps.dir);
		const attempt = yield* acquireLedgerLock(deps.fs, lockDir);
		if (attempt === "absent") return refusals.onAbsent(deps.dir);
		if (attempt === "held") {
			return refusals.onLocked(
				lockDir,
				`another writer holds ${lockDir} — concurrent writers are serialized, so retry this exact event once the holder clears`,
			);
		}
		return yield* Effect.onExit(inner, () => removeLock(deps.fs, lockDir));
	});

/** The refusal message fragment every appending verb shares on lock-budget exhaustion. */
export const lockedRefusal = (verb: string, lockDir: string): string =>
	`${verb}: refused (log unappended): another writer holds ${lockDir} — concurrent ledger writes are serialized (${CONCURRENT_WRITE}); retry this exact event once the holder clears.`;

// Re-exported so callers need no second import site for the refusal seat.
export {CONCURRENT_WRITE};
