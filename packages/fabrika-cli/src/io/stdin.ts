/**
 * The fd-0 boundary — a body arrives as bytes, and a pipe that could not be read is never empty.
 *
 * The read is a raw `node:fs` `readSync` on purpose, which is the standing ruling in
 * [.patterns/effect-platform-access.md](../../../../.patterns/effect-platform-access.md)
 * (§"The bright line" — fd 0 stays a raw read at the boundary; `Stdio.stdin` is a
 * considered-and-declined stream swap, not a missing service). **No `effect` import here**, for the
 * same reason: the retry loop needs a native `try/catch` around each `readSync`, which is banned
 * inside Effect control flow (#2736). The CLI adapter lifts {@link readStdin} into an effect, and
 * the verbs take that effect as an option — so a test drives the `EAGAIN` and TTY paths without a
 * real descriptor.
 *
 * **`Text("")` and `Failed` are different answers and must never collapse.** A non-blocking pipe
 * throws `EAGAIN` before its producer writes, and swallowing that to `""` makes an unread pipe
 * byte-identical to an empty one — the caller then decides over evidence it never saw (#3924, and
 * ADR 0092's zero-scope fail-open). Reimplemented here rather than reused: ADR 0238 bans calling
 * v1, so its scar is duplicated as behaviour, not as a dependency.
 */
import {readSync} from "node:fs";

export type StdinRead =
	/** Bytes arrived and decoded. `text` may be `""` — a genuinely empty pipe stays an answer. */
	| {readonly _tag: "Text"; readonly text: string}
	/** fd 0 carried nothing to read at all: a TTY, or a descriptor that is not attached. */
	| {readonly _tag: "NoStdin"; readonly reason: string}
	/** The read itself failed. The body is UNKNOWN. */
	| {readonly _tag: "Failed"; readonly reason: string};

/** The process-level reads the loop needs, injected so the retry path is testable. */
export interface StdinIo {
	readonly isTTY: boolean;
	/** Read up to `into.length` bytes; returns the byte count, `0` at EOF. Throws an errno error. */
	readonly read: (into: Uint8Array) => number;
	readonly sleep: (ms: number) => void;
	readonly now: () => number;
}

export interface StdinOptions {
	/**
	 * How long the reader tolerates making no progress before giving up loudly. It resets on every
	 * byte, so a slow producer is fine and only a stalled pipe trips it — which is what keeps
	 * "retry until it drains" from becoming an unbounded hang.
	 */
	readonly idleTimeoutMs?: number;
	readonly pollMs?: number;
	readonly chunkBytes?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 5;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

/** Errno codes meaning "no data yet", not "this read failed". */
const RETRYABLE = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);
/** Errno codes meaning fd 0 is not attached — an absent pipe, not an unread one. */
const UNATTACHED = new Set(["EBADF", "ENXIO", "ENOTCONN"]);

const errnoOf = (error: unknown): string =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: "";

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** Read fd 0 to EOF. Terminates in every direction: a TTY returns first, EOF ends it, a stall trips. */
export const readStdinWith = (io: StdinIo, options: StdinOptions = {}): StdinRead => {
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;

	// A check rather than a deadline: on a TTY the read blocks on keystrokes, which no timeout can
	// tell apart from a slow producer.
	if (io.isTTY) return {_tag: "NoStdin", reason: "fd 0 is a TTY — nothing was piped in"};

	const chunks: Uint8Array[] = [];
	let bytesRead = 0;
	let lastProgress = io.now();

	for (;;) {
		const buffer = new Uint8Array(chunkBytes);
		let n: number;
		try {
			n = io.read(buffer);
		} catch (error) {
			const code = errnoOf(error);
			if (RETRYABLE.has(code)) {
				if (io.now() - lastProgress >= idleTimeoutMs) {
					return {
						_tag: "Failed",
						reason: `fd 0 is a non-blocking pipe that returned ${code} with no data for ${idleTimeoutMs}ms (${bytesRead} bytes so far)`,
					};
				}
				io.sleep(pollMs);
				continue;
			}
			if (UNATTACHED.has(code) && bytesRead === 0) {
				return {_tag: "NoStdin", reason: `fd 0 is not readable (${code}) — nothing was piped in`};
			}
			return {
				_tag: "Failed",
				reason: `${code === "" ? "" : `${code}: `}${messageOf(error)} (${bytesRead} bytes so far)`,
			};
		}
		if (n === 0) break;
		chunks.push(buffer.subarray(0, n));
		bytesRead += n;
		lastProgress = io.now();
	}

	// Decode once over the joined bytes: a multi-byte character split across two reads would be
	// mangled by per-chunk decoding.
	const joined = new Uint8Array(bytesRead);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return {_tag: "Text", text: new TextDecoder("utf-8").decode(joined)};
};

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** {@link readStdinWith} bound to the real process — the one place fd 0 is named. */
export const readStdin = (): StdinRead =>
	readStdinWith({
		isTTY: process.stdin.isTTY === true,
		read: (into) => readSync(0, into, 0, into.length, null),
		sleep: sleepSync,
		now: () => Date.now(),
	});
