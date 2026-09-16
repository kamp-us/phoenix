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
 * otherwise leave the sidecar forever, so a lock whose holder stopped being plausible
 * {@link STALE_LOCK_MS} ago is taken over on sight. Anything newer is presumed alive; waiting is the
 * honest answer.
 *
 * **Who holds it is written down, which is what makes the take-over safe.** The sidecar carries one
 * {@link HOLDER_FILE} naming the writer and the instant it acquired, so every act past the first
 * `mkdir` names a holder instead of a path: the take-over replaces that stamp **inside** the
 * directory rather than moving the directory, a holder verifies the stamp is still its own before
 * its body runs, and a release removes only a sidecar it still holds. The directory therefore never
 * leaves the path while anyone holds it, so no third writer's `mkdir` can slip into a gap — the
 * lock's whole guarantee is that exactly one writer is inside the body, and a vacancy anywhere
 * along this path hands it to two.
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
import {randomUUID} from "node:crypto";
import {Effect, type FileSystem, Option, type Path, Result} from "effect";
import {CONCURRENT_WRITE} from "./codes.ts";
import {WORKFLOW_FILE} from "./store.ts";

/** The sidecar directory a holding writer creates inside the lane directory. */
export const LOCK_DIR_NAME = "events.lock";

/** The one file inside the sidecar naming who holds it and when they took it. */
const HOLDER_FILE = "holder";

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

/**
 * One writer's claim on the sidecar: who, and from when.
 *
 * Both halves ride one line because both are read in one `readFileString`. A verdict that stats the
 * directory for the age and then reads the file for the identity samples two instants, and a lock
 * that changed hands between them reads as the aged one it no longer is — which is the take-over of
 * a live lock this stamp exists to refuse.
 */
interface LockStamp {
	/** The bytes as they were read — the only thing a take-over compares, so it never re-derives. */
	readonly line: string;
	readonly holder: string;
	/** `none` when the line is not one this module wrote; UNKNOWN never decides staleness. */
	readonly acquiredAt: Option.Option<number>;
}

const holderPath = (lockDir: string): string => `${lockDir}/${HOLDER_FILE}`;

const stampLine = (holder: string): string => `${holder} ${Date.now()}`;

const readStamp = (
	fs: FileSystem.FileSystem,
	lockDir: string,
): Effect.Effect<Option.Option<LockStamp>, never> =>
	Effect.gen(function* () {
		const read = yield* Effect.result(fs.readFileString(holderPath(lockDir)));
		if (Result.isFailure(read)) return Option.none();
		const line = read.success.trim();
		const [holder = "", at = ""] = line.split(" ");
		const acquiredAt = Number(at);
		return Option.some({
			line,
			holder,
			acquiredAt:
				Number.isFinite(acquiredAt) && at !== "" ? Option.some(acquiredAt) : Option.none(),
		});
	});

/**
 * Become the holder, or answer that someone else already is.
 *
 * `wx` is the whole mechanism: an exclusive create either lands the file or fails `AlreadyExists`,
 * so of any number of writers reaching for one vacant stamp exactly one leaves holding it. Verified
 * on darwin — a second `writeFileSync(path, data, {flag: "wx"})` over the same path is `EEXIST`,
 * which `@effect/platform-node-shared`'s `internal/utils.ts` maps to `AlreadyExists`.
 */
const claimHolder = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: string,
): Effect.Effect<boolean, never> =>
	Effect.map(
		Effect.result(fs.writeFileString(holderPath(lockDir), stampLine(holder), {flag: "wx"})),
		Result.isSuccess,
	);

/** Whether this writer is still the one the sidecar names. An unreadable stamp is not a yes. */
const holdsLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: string,
): Effect.Effect<boolean, never> =>
	Effect.map(
		readStamp(fs, lockDir),
		Option.match({onNone: () => false, onSome: (stamp) => stamp.holder === holder}),
	);

const removeLock = (fs: FileSystem.FileSystem, lockDir: string): Effect.Effect<void, never> =>
	Effect.ignore(fs.remove(lockDir, {recursive: true}));

const acquireOnce = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: string,
): Effect.Effect<LockAttempt, never> =>
	Effect.gen(function* () {
		const made = yield* Effect.result(fs.makeDirectory(lockDir, {recursive: false}));
		if (Result.isFailure(made)) {
			// A non-recursive mkdir fails two ways that mean opposite things, so the reason decides it:
			// EEXIST (`AlreadyExists`) is the atomic-mkdir race — someone holds the lock — while ENOENT
			// (`NotFound`) is the lane directory itself missing, which no amount of waiting fixes. The
			// errno mapping is `@effect/platform-node-shared`'s `internal/utils.ts`.
			return made.failure.reason._tag === "NotFound" ? "absent" : "held";
		}
		// The mkdir already made this writer the only possible holder, so the stamp cannot be lost to a
		// race — only to a failing write, and a sidecar nobody can be proven to hold is one this writer
		// must not keep.
		if (yield* claimHolder(fs, lockDir, holder)) return "acquired";
		yield* removeLock(fs, lockDir);
		return "held";
	});

/**
 * Whether the sidecar itself has sat untouched past the horizon — the staleness read for the two
 * cases a stamp cannot answer.
 *
 * Every act on a holder's stamp writes through the directory, so its mtime is the last moment the
 * lock plausibly changed hands: a directory older than the horizon has had no stamp land in it for
 * that long, which is a creator that died before stamping, never a live holder. (Verified on darwin:
 * both a `writeFileSync` inside the directory and a `renameSync` of an entry out of it move the
 * directory's own mtime.)
 */
const aged = (fs: FileSystem.FileSystem, lockDir: string): Effect.Effect<boolean, never> =>
	Effect.map(Effect.result(fs.stat(lockDir)), (probed) => {
		if (Result.isFailure(probed)) return false;
		const mtime = probed.success.mtime;
		return Option.isSome(mtime) && Date.now() - mtime.value.getTime() > STALE_LOCK_MS;
	});

/**
 * Take over a lock whose holder is presumed dead, answering whether **this writer now holds it**.
 *
 * **The take-over never moves the sidecar, and that is the whole of its safety.** What the steal
 * guarantees against a lock that became live between the read and the take is that it leaves it
 * alone — and it can only guarantee that if a writer who guessed wrong can put things back without
 * anyone noticing. A steal that renames the directory away and back cannot: for those two syscalls
 * the lock path is vacant while its real holder is mid-body, so a third writer's `mkdir` lands and
 * two bodies append to one log. Here the directory stays where it is and only the stamp inside it
 * changes hands, so the one thing an acquirer tests — `mkdir` on `lockDir` — is never satisfiable
 * while anybody holds the lock.
 *
 * The take itself is a `rename` of the stamp onto a private name: `rename` is atomic, so of two
 * waiters past one horizon exactly one carries the stamp off and the loser's `NotFound` sends it
 * back to polling. The bytes that land under the private name are compared against the bytes the
 * verdict was reached on, so a lock that changed hands in between is recognised and its stamp
 * renamed straight back. A stamp absent altogether is a holder that died between its `mkdir` and
 * its stamp, and taking that one over is the exclusive create alone — nothing to compare, and
 * nothing that can be taken from the winner.
 *
 * A restore is invisible to acquirers and briefly visible to the live holder, which is why
 * {@link withLedgerLock} treats an unreadable stamp as "not mine": that holder refuses its own body
 * and retries, which is the fail-safe direction. A `stat` or read that fails, or an unparseable
 * stamp with no readable directory mtime behind it, is UNKNOWN — and UNKNOWN never steals.
 */
const stealIfStale = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: string,
): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const stamp = yield* readStamp(fs, lockDir);
		if (Option.isNone(stamp)) {
			return (yield* aged(fs, lockDir)) ? yield* claimHolder(fs, lockDir, holder) : false;
		}
		const since = Option.isSome(stamp.value.acquiredAt)
			? Date.now() - stamp.value.acquiredAt.value > STALE_LOCK_MS
			: yield* aged(fs, lockDir);
		if (!since) return false;
		// Private to this attempt, so two waiters never contend for the name they carry the stamp off to.
		const taken = `${holderPath(lockDir)}.stolen-${randomUUID()}`;
		const moved = yield* Effect.result(fs.rename(holderPath(lockDir), taken));
		if (Result.isFailure(moved)) return false;
		const carried = yield* Effect.result(fs.readFileString(taken));
		if (Result.isFailure(carried) || carried.success.trim() !== stamp.value.line) {
			// Someone else's claim, or bytes this writer cannot vouch for. Put it back under its own
			// name and keep waiting — a live holder is not ours to end.
			yield* Effect.ignore(fs.rename(taken, holderPath(lockDir)));
			return false;
		}
		const claimed = yield* claimHolder(fs, lockDir, holder);
		yield* Effect.ignore(fs.remove(taken));
		return claimed;
	});

/**
 * Wait for and hold the lane's write lock. `acquired` means this writer holds it under the `holder`
 * it was given — release is the caller's duty, best-effort via {@link releaseLedgerLock}. `held`
 * means the budget ran out with the lock still held elsewhere, and `absent` that the directory the
 * lock would live in is not there. Neither refusal leaves anything behind: the only thing this
 * writes is its own stamp, and a stamp it cannot keep goes with the sidecar it stamped.
 *
 * `absent` returns on the first attempt instead of polling: waiting out the budget for a directory
 * to appear reports contention that can never clear, which is what sent a shipper into a retry loop
 * against a lane nobody had opened.
 */
export const acquireLedgerLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	budgetMs: number = lockBudgetMs(),
	holder: string = randomUUID(),
): Effect.Effect<LockAttempt, never> =>
	Effect.gen(function* () {
		const deadline = Date.now() + budgetMs;
		while (true) {
			const attempt = yield* acquireOnce(fs, lockDir, holder);
			if (attempt !== "held") return attempt;
			// A successful take-over IS the hold: the sidecar never left the path, so there is no second
			// `mkdir` to make and nothing for a third writer to have taken in between.
			if (yield* stealIfStale(fs, lockDir, holder)) return "acquired";
			if (Date.now() >= deadline) return "held";
			yield* Effect.sleep(`${POLL_MS} millis`);
		}
	});

/**
 * Best-effort release of a lock this writer still holds. A failed removal leaves the lock to be
 * taken over as stale, never retried here.
 *
 * The stamp check is what keeps a slow writer from releasing someone else's lock: a holder that
 * outlived the horizon has had its sidecar taken over in place, and an unconditional remove would
 * hand the new holder's lock to a third writer mid-body.
 */
export const releaseLedgerLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: string,
): Effect.Effect<void, never> =>
	Effect.flatMap(holdsLock(fs, lockDir, holder), (mine) =>
		mine ? removeLock(fs, lockDir) : Effect.void,
	);

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
 * the holder clears" — and it belongs to a lock somebody else holds, whether this writer never took
 * it or took it and lost it: a hold that cannot be proven the instant before the body runs is one
 * this writer does not have, and the retry is the same either way. `onAbsent` is the lane's
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
		const holder = randomUUID();
		const attempt = yield* acquireLedgerLock(deps.fs, lockDir, lockBudgetMs(), holder);
		if (attempt === "absent") return refusals.onAbsent(deps.dir);
		if (attempt === "held") {
			return refusals.onLocked(
				lockDir,
				`another writer holds ${lockDir} — concurrent writers are serialized, so retry this exact event once the holder clears`,
			);
		}
		// The body is where the append lives, so the last thing before it is the last moment a
		// hand-off can still be answered by refusing rather than by two writers appending.
		if (!(yield* holdsLock(deps.fs, lockDir, holder))) {
			return refusals.onLocked(
				lockDir,
				`${lockDir} is no longer this writer's to hold — it changed hands before this body ran, so retry this exact event`,
			);
		}
		return yield* Effect.onExit(inner, () => releaseLedgerLock(deps.fs, lockDir, holder));
	});

/** The refusal message fragment every appending verb shares on lock-budget exhaustion. */
export const lockedRefusal = (verb: string, lockDir: string): string =>
	`${verb}: refused (log unappended): another writer holds ${lockDir} — concurrent ledger writes are serialized (${CONCURRENT_WRITE}); retry this exact event once the holder clears.`;

// Re-exported so callers need no second import site for the refusal seat.
export {CONCURRENT_WRITE};
