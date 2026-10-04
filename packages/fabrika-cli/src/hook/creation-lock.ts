/**
 * The one repo-level lock `hook worktree-create` takes, around its base fetch and `git worktree add`
 * and nothing else.
 *
 * It lives in the clone's **common** git dir, so every worktree of the clone contends for the same
 * lock whichever tree the envelope's `cwd` names. The dependency install after it runs outside, which
 * is what keeps the hold short: a fetch and an add, measured in hundreds
 * of milliseconds, never a ~10s install.
 * @ruling https://github.com/kamp-us/phoenix/issues/7057
 *
 * The primitive is an atomic `mkdir` of the lock directory, then an exclusive create of one
 * {@link HOLDER_FILE} inside it naming the holder's process. Whoever lands the `mkdir` is the only
 * possible holder.
 *
 * **A holder that died must not block every later spawn.** A hold spans a network fetch, so no age
 * short enough to wait out can tell a slow holder from a dead one. What can is the holder's pid: a
 * holder on this host whose process is gone is dead however young its stamp is. A stamp older than
 * {@link HOLD_HORIZON_MS} is dead too, whatever its pid says, because the harness has already ended
 * any hook that old — which also bounds the one case a pid cannot answer, a pid reused by an
 * unrelated process.
 *
 * **The take-over never moves the lock directory.** Only the stamp inside it changes hands, so the
 * one thing an acquirer tests — `mkdir` of the lock path — is never satisfiable while anyone holds
 * it. The take itself renames the stamp onto a private name and compares the bytes it carried off
 * against the bytes the verdict was reached on; a stamp that changed hands in between is renamed
 * straight back. This is the protocol `../lane/append-lock.ts` runs, with a liveness verdict in
 * place of its age-only one.
 */
import {randomUUID} from "node:crypto";
import {hostname} from "node:os";
import {Effect, type FileSystem, Option, Result, Schema} from "effect";

/** Where the lock sits under a clone's common git dir. */
export const lockDirFor = (commonDir: string): string =>
	`${commonDir}/fabrika/worktree-create.lock`;

const HOLDER_FILE = "holder";

const holderPath = (lockDir: string): string => `${lockDir}/${HOLDER_FILE}`;

/**
 * The hook's own 600s budget plus a margin. No live hook holds the lock longer than the harness lets
 * it run, so a stamp past this is a holder the harness already ended.
 */
export const HOLD_HORIZON_MS = 660_000;

/**
 * How long a lock directory may sit with no readable stamp before it is presumed abandoned — a
 * creator that died between its `mkdir` and its stamp. The two writes are back to back, so this is a
 * wide margin over the gap a live creator can leave.
 */
export const STAMP_GRACE_MS = 10_000;

/**
 * How long a spawn waits for the lock before refusing. A hold is a fetch and an add, so a queue of
 * parallel spawns clears in seconds; a wait this long means a live holder is stuck on its fetch, and
 * the wait must end early enough for the refusal to reach the harness inside the hook's 600s.
 */
export const WAIT_BUDGET_MS = 240_000;

const POLL_MS = 100;

/** Who holds the lock: one process on one host, from one instant. */
const HolderSchema = Schema.Struct({
	id: Schema.String,
	pid: Schema.Int,
	host: Schema.String,
	at: Schema.Finite,
});
export type Holder = typeof HolderSchema.Type;

/** The facts about this process a verdict needs, injected so a test can state them. */
export interface LockHost {
	readonly pid: number;
	readonly host: string;
	readonly now: () => number;
	/** Whether a process with this pid exists on this host right now. */
	readonly alive: (pid: number) => boolean;
}

/** `kill(pid, 0)` sends nothing: it succeeds for a live pid and fails `ESRCH` for a gone one. */
export const processAlive = (pid: number): boolean => {
	const signalled = Result.try({
		try: () => process.kill(pid, 0),
		catch: (cause) => (cause as NodeJS.ErrnoException).code,
	});
	// EPERM is a live process this user may not signal — alive, and not ours to judge dead.
	return Result.isSuccess(signalled) || signalled.failure === "EPERM";
};

export const thisProcess: LockHost = {
	pid: process.pid,
	host: hostname(),
	now: Date.now,
	alive: processAlive,
};

export const stampOf = (holder: Holder): string => JSON.stringify(holder);

/** A stamp this module wrote, or `none` for bytes it cannot vouch for. */
export const parseStamp: (line: string) => Option.Option<Holder> = Schema.decodeUnknownOption(
	Schema.fromJsonString(HolderSchema),
);

/**
 * Whether a holder is still plausibly inside its hold.
 *
 * A holder on another host is judged by age alone, since its pid names nothing here. A common git dir
 * shared across hosts is not a layout this repo uses, and the horizon still bounds it.
 */
export const holderIsLive = (holder: Holder, self: LockHost): boolean => {
	if (self.now() - holder.at > HOLD_HORIZON_MS) return false;
	if (holder.host !== self.host) return true;
	return self.alive(holder.pid);
};

export type Acquired =
	| {readonly _tag: "Held"; readonly holder: Holder}
	| {readonly _tag: "Busy"; readonly holder: Option.Option<Holder>}
	| {readonly _tag: "Unplaceable"; readonly reason: string};

const claim = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: Holder,
): Effect.Effect<boolean, never> =>
	Effect.map(
		Effect.result(fs.writeFileString(holderPath(lockDir), stampOf(holder), {flag: "wx"})),
		Result.isSuccess,
	);

const readHolder = (
	fs: FileSystem.FileSystem,
	lockDir: string,
): Effect.Effect<Option.Option<{readonly line: string; readonly holder: Option.Option<Holder>}>> =>
	Effect.map(Effect.result(fs.readFileString(holderPath(lockDir))), (read) => {
		if (Result.isFailure(read)) return Option.none();
		const line = read.success.trim();
		return Option.some({line, holder: parseStamp(line)});
	});

const holds = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: Holder,
): Effect.Effect<boolean, never> =>
	Effect.map(readHolder(fs, lockDir), (read) =>
		Option.match(read, {
			onNone: () => false,
			onSome: ({line}) => line === stampOf(holder),
		}),
	);

/** Whether the lock directory has sat unstamped past {@link STAMP_GRACE_MS}. */
const abandoned = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	self: LockHost,
): Effect.Effect<boolean, never> =>
	Effect.map(Effect.result(fs.stat(lockDir)), (probed) => {
		if (Result.isFailure(probed)) return false;
		const mtime = probed.success.mtime;
		return Option.isSome(mtime) && self.now() - mtime.value.getTime() > STAMP_GRACE_MS;
	});

type Attempt = "acquired" | "held" | "unplaceable";

const acquireOnce = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: Holder,
): Effect.Effect<Attempt, never> =>
	Effect.gen(function* () {
		const made = yield* Effect.result(fs.makeDirectory(lockDir, {recursive: false}));
		if (Result.isFailure(made)) {
			return made.failure.reason._tag === "AlreadyExists" ? "held" : "unplaceable";
		}
		if (yield* claim(fs, lockDir, holder)) return "acquired";
		yield* Effect.ignore(fs.remove(lockDir, {recursive: true}));
		return "unplaceable";
	});

/**
 * Take over a lock whose holder is dead, answering whether this spawn now holds it. An unreadable
 * stat or a stamp that changed hands mid-take is never a steal.
 */
const stealIfDead = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: Holder,
	self: LockHost,
): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const read = yield* readHolder(fs, lockDir);
		if (Option.isNone(read)) {
			return (yield* abandoned(fs, lockDir, self)) ? yield* claim(fs, lockDir, holder) : false;
		}
		const dead = Option.match(read.value.holder, {
			onNone: () => false,
			onSome: (standing) => !holderIsLive(standing, self),
		});
		const unvouched = Option.isNone(read.value.holder) && (yield* abandoned(fs, lockDir, self));
		if (!dead && !unvouched) return false;
		const taken = `${holderPath(lockDir)}.taken-${randomUUID()}`;
		const moved = yield* Effect.result(fs.rename(holderPath(lockDir), taken));
		if (Result.isFailure(moved)) return false;
		const carried = yield* Effect.result(fs.readFileString(taken));
		if (Result.isFailure(carried) || carried.success.trim() !== read.value.line) {
			yield* Effect.ignore(fs.rename(taken, holderPath(lockDir)));
			return false;
		}
		const claimed = yield* claim(fs, lockDir, holder);
		yield* Effect.ignore(fs.remove(taken));
		return claimed;
	});

/**
 * Wait for the lock and hold it, within {@link WAIT_BUDGET_MS}. `Busy` carries the holder the
 * wait ran out against, so the refusal can name it; `Unplaceable` is a lock that cannot be created
 * at all, which no wait fixes.
 */
export const acquireCreationLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	self: LockHost,
	budgetMs: number = WAIT_BUDGET_MS,
): Effect.Effect<Acquired, never> =>
	Effect.gen(function* () {
		const parent = lockDir.slice(0, lockDir.lastIndexOf("/"));
		const placed = yield* Effect.result(fs.makeDirectory(parent, {recursive: true}));
		if (Result.isFailure(placed)) {
			return {_tag: "Unplaceable", reason: `could not create ${parent}: ${placed.failure.message}`};
		}
		const holder: Holder = {id: randomUUID(), pid: self.pid, host: self.host, at: self.now()};
		const deadline = self.now() + budgetMs;
		while (true) {
			const attempt = yield* acquireOnce(fs, lockDir, holder);
			if (attempt === "acquired") return {_tag: "Held", holder};
			if (attempt === "unplaceable") {
				return {_tag: "Unplaceable", reason: `could not create ${lockDir}`};
			}
			if (yield* stealIfDead(fs, lockDir, holder, self)) return {_tag: "Held", holder};
			if (self.now() >= deadline) {
				const standing = yield* readHolder(fs, lockDir);
				return {
					_tag: "Busy",
					holder: Option.flatMap(standing, (read) => read.holder),
				};
			}
			yield* Effect.sleep(`${POLL_MS} millis`);
		}
	});

/** Remove the lock only while it is still this holder's, so a late release frees nobody else's. */
export const releaseCreationLock = (
	fs: FileSystem.FileSystem,
	lockDir: string,
	holder: Holder,
): Effect.Effect<void, never> =>
	Effect.flatMap(holds(fs, lockDir, holder), (mine) =>
		mine ? Effect.ignore(fs.remove(lockDir, {recursive: true})) : Effect.void,
	);

/**
 * Run `body` inside the lock, releasing it on every exit — refusal, defect and interruption alike.
 * A process killed outright releases nothing, and that is the dead-holder case the steal covers.
 */
export const withCreationLock = <A, R>(
	fs: FileSystem.FileSystem,
	lockDir: string,
	self: LockHost,
	body: Effect.Effect<A, never, R>,
	refusals: {
		readonly onBusy: (holder: Option.Option<Holder>) => A;
		readonly onUnplaceable: (reason: string) => A;
	},
	budgetMs: number = WAIT_BUDGET_MS,
): Effect.Effect<A, never, R> =>
	Effect.gen(function* () {
		const acquired = yield* acquireCreationLock(fs, lockDir, self, budgetMs);
		if (acquired._tag === "Busy") return refusals.onBusy(acquired.holder);
		if (acquired._tag === "Unplaceable") return refusals.onUnplaceable(acquired.reason);
		return yield* Effect.onExit(body, () => releaseCreationLock(fs, lockDir, acquired.holder));
	});
