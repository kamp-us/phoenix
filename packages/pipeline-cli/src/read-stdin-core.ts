/**
 * The pure core of the fail-closed stdin read (#3924).
 *
 * `readFileSync(0, "utf8")` throws `EAGAIN` when fd 0 is a non-blocking pipe — which it can
 * be depending on what is upstream, so it is intermittent by nature. Every pipeline-cli tool
 * wrapped that call in a swallow-to-empty, which made an *unread* pipe indistinguishable from
 * an *empty* one: a gate then computed its verdict over no evidence and called the vacuous
 * green a real zero scope (ADR 0092).
 *
 * The fix is a type, not a retry knob: a present-but-unread pipe resolves to `Failed`, and `""`
 * is reserved for a pipe that genuinely carried nothing. The three outcomes are disjoint and
 * exhaustive, so "unknown" can no longer be spelled the same way as "no members".
 *
 * The IO is injected (`StdinIo`) so the EAGAIN path is unit-testable without a real
 * non-blocking fd; `nodeStdinIo` binds it to the process. No `effect` import here on purpose —
 * the retry loop needs a native `try/catch` around each `readSync`, and this file is the
 * node-boundary half that the `read-stdin.ts` Effect seam wraps.
 */
import {readSync} from "node:fs";

/**
 * The outcome of a stdin read.
 *
 * `Text.text` may be `""` — that is a *genuinely empty* pipe, which stays a legitimate answer.
 * What can no longer happen is a failed read arriving as `Text("")`.
 */
export type StdinRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "NoStdin"; readonly reason: string}
	| {readonly _tag: "Failed"; readonly reason: string};

/** The process-level reads the core needs, injected so a test can drive the EAGAIN path. */
export interface StdinIo {
	/** True when fd 0 is a terminal — the no-hang exit: a TTY with nothing piped never blocks. */
	readonly isTTY: boolean;
	/** Read up to `into.length` bytes; returns the byte count, `0` at EOF. Throws an errno error. */
	readonly read: (into: Uint8Array) => number;
	readonly sleep: (ms: number) => void;
	readonly now: () => number;
}

export interface StdinReadOptions {
	/**
	 * How long the reader tolerates making no progress before giving up **loudly**. The bound is
	 * what keeps "retry until the pipe drains" from becoming an unbounded hang; it resets on every
	 * byte read, so a slow producer is fine and only a truly stalled pipe trips it.
	 */
	readonly idleTimeoutMs?: number;
	readonly pollMs?: number;
	readonly chunkBytes?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 5;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** Errno codes that mean "no data available yet", not "this read failed". */
const RETRYABLE = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);

/** Errno codes that mean fd 0 is not attached at all — an absent pipe, not an unread one. */
const NO_STDIN = new Set(["EBADF", "ENXIO", "ENOTCONN"]);

const errnoOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: "";

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Read fd 0 to EOF, retrying a non-blocking pipe's `EAGAIN` instead of swallowing it.
 *
 * Terminates in every direction: a TTY returns before the first read, EOF ends the loop, and a
 * pipe that stops making progress trips `idleTimeoutMs` into `Failed` rather than spinning.
 */
export const readStdinWith = (io: StdinIo, options: StdinReadOptions = {}): StdinRead => {
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;

	// The no-hang guarantee, and why it is a check rather than a timeout: on a TTY the read would
	// block on the operator's keystrokes, which no deadline can distinguish from a slow producer.
	if (io.isTTY) return {_tag: "NoStdin", reason: "fd 0 is a TTY — nothing was piped in"};

	const chunks: Array<Buffer> = [];
	let bytesRead = 0;
	let lastProgress = io.now();

	for (;;) {
		const buffer = Buffer.allocUnsafe(chunkBytes);
		let n: number;
		try {
			n = io.read(buffer);
		} catch (error) {
			const code = errnoOf(error);
			if (RETRYABLE.has(code)) {
				if (io.now() - lastProgress >= idleTimeoutMs) {
					return {
						_tag: "Failed",
						reason: `stdin read stalled: fd 0 is a non-blocking pipe that returned ${code} with no data for ${idleTimeoutMs}ms (${bytesRead} bytes read so far). Refusing to report this as empty stdin (#3924).`,
					};
				}
				io.sleep(pollMs);
				continue;
			}
			if (NO_STDIN.has(code) && bytesRead === 0) {
				return {_tag: "NoStdin", reason: `fd 0 is not readable (${code}) — nothing was piped in`};
			}
			return {
				_tag: "Failed",
				reason: `stdin read failed${code === "" ? "" : ` (${code})`}: ${messageOf(error)} (${bytesRead} bytes read so far). Refusing to report this as empty stdin (#3924).`,
			};
		}
		if (n === 0) break;
		chunks.push(buffer.subarray(0, n));
		bytesRead += n;
		lastProgress = io.now();
	}

	// Decode once, over the joined bytes: a multi-byte character split across two reads would be
	// mangled by per-chunk decoding.
	return {_tag: "Text", text: Buffer.concat(chunks).toString("utf8")};
};

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Bind `readStdinWith` to the real process (fd 0 by default; a fd argument is for tests). */
export const nodeStdinIo = (fd = 0, isTTY = process.stdin.isTTY === true): StdinIo => ({
	isTTY,
	read: (into) => readSync(fd, into, 0, into.length, null),
	sleep: sleepSync,
	now: () => Date.now(),
});
