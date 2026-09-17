/**
 * The child process, and the only file in this package that knows one exists.
 *
 * It is a plain function — "start this, tell me when it is over, here is how to abandon it" — and
 * `./runner.ts` is the one place it is wrapped: the live `ShellRunner` is this function as an
 * Effect, with the abandon hung on the Effect's finalizer. Keeping the callback shape here rather
 * than writing the Effect inline is what lets the timeout, the group kill and the output bound be
 * tested against real processes without a program, a kernel or a desk.
 *
 * **The child gets its own process group** (`detached: true`), and that is the whole reason a
 * timeout works at all. `sh -c "sleep 60 | cat"` is three processes; killing the shell alone leaves
 * the pipeline up, holding the pipe this function is reading, so `close` never fires and the
 * "timeout" hangs for ever. `process.kill(-pid, …)` addresses the group, which is every one of them.
 */

import {spawn} from "node:child_process";
import {boundedTail, OUTPUT_BYTE_LIMIT} from "./state.ts";

/** What to run, and under what conditions. Every field is decided at `shell(...)`, bar the command. */
export interface ShellCommand {
	/** The prompt's `key`, carried through untouched so a finish can be matched to its request. */
	readonly key: string;
	/** The command line, run *through the shell* — so pipes, redirects and `&&` mean what they say. */
	readonly command: string;
	readonly cwd: string;
	/** The interpreter, e.g. `/bin/zsh`. Invoked as `<shell> -c <command>`. */
	readonly shell: string;
	/** Kill the group after this long. `null` waits as long as the command takes. */
	readonly timeoutMs: number | null;
	/** Extra environment, over the ambient one — a child with no `PATH` can run almost nothing. */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * What a finished command reports back. It is the program's own event, named here because this
 * module is what produces one: the handler answers a list holding exactly this, and the actor
 * dispatches it into the program's own inbox.
 */
export interface Finished {
	readonly type: "finished";
	readonly key: string;
	/** The exit code, or `null` when the process was killed or never started at all. */
	readonly code: number | null;
	/**
	 * stdout and stderr, interleaved in arrival order, **already cut** to `OUTPUT_BYTE_LIMIT` — the
	 * last bytes, with a note in front saying how many earlier ones were lost. Bounded here rather
	 * than by the caller because only this side knows what its rolling window already threw away.
	 */
	readonly output: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

/** Abandon a run: kill the group and report nothing. What the handler's finalizer calls. */
export type Abandon = () => void;

/**
 * Kill a whole process group, by the negative pid convention. Swallows `ESRCH` — the group having
 * already gone is the outcome this asks for, not an error — and nothing else can be done about a
 * kill that fails anyway, since the reporting path is the `close` event either way.
 */
const killGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// Already gone, or never a group. Either way there is nothing left to end.
	}
};

/**
 * A rolling tail of the output. Chunks are dropped off the front once the total passes twice the
 * bound, so a command that prints a gigabyte costs a bounded amount of memory rather than a
 * bounded amount of *reported* output over an unbounded buffer.
 */
class Tail {
	private chunks: Array<Buffer> = [];
	private total = 0;
	private dropped = 0;

	constructor(private readonly limit: number) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.total += chunk.length;
		while (this.total > this.limit * 2) {
			const head = this.chunks.shift();
			if (head === undefined) break;
			this.total -= head.length;
			this.dropped += head.length;
		}
	}

	/** Everything still held, decoded as UTF-8. `./state.ts`'s `boundedTail` does the final cut. */
	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}

	/** How many bytes fell off the front before the final cut ever saw them. */
	lost(): number {
		return this.dropped;
	}
}

/**
 * Start a command and report once. The report happens exactly once — on `close`, on `error`, or not
 * at all if the run was abandoned first — because the caller is a state machine that pairs one
 * finish with one request and a second report would be a second run it never asked for.
 */
export const startCommand = (
	request: ShellCommand,
	report: (finished: Finished) => void,
	now: () => number = Date.now,
): Abandon => {
	const startedAt = now();
	const tail = new Tail(OUTPUT_BYTE_LIMIT);
	let timedOut = false;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const child = spawn(request.shell, ["-c", request.command], {
		cwd: request.cwd,
		env: {...process.env, ...request.env},
		// Its own process group, so a timeout can end a pipeline rather than only its first process.
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});

	const finish = (code: number | null, extra: string): void => {
		if (done) return;
		done = true;
		if (timer !== null) clearTimeout(timer);
		report({
			type: "finished",
			key: request.key,
			code,
			output: boundedTail(tail.text() + extra, OUTPUT_BYTE_LIMIT, tail.lost()),
			timedOut,
			durationMs: now() - startedAt,
		});
	};

	child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));

	// A spawn that never happened — a `cwd` that is not a directory, an interpreter that is not on
	// disk. It is a failed run with no exit code, and the message is the only output there will be.
	child.on("error", (error: Error) => finish(null, `${error.message}\n`));

	// `close` rather than `exit`, because `exit` can fire while the pipes are still draining and the
	// last line of a build's output is exactly the line worth having.
	child.on("close", (code: number | null) => finish(code, ""));

	if (request.timeoutMs !== null) {
		timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid, "SIGKILL");
		}, request.timeoutMs);
	}

	return () => {
		if (done) return;
		done = true;
		if (timer !== null) clearTimeout(timer);
		killGroup(child.pid, "SIGKILL");
	};
};
