/**
 * The machine, faked — and recording. Every test in this package runs against this and never
 * against `nodeRunner()`, which is the whole reason the `Runner` port exists: a suite that really
 * ran `git worktree add` would leave worktrees behind the first time it failed, and a suite that
 * really bound a port would fail on a laptop with a dev server up.
 *
 * It is in `src/` rather than in a test file because it is exported: a consumer writing their own
 * config's test wants the same fake, and rebuilding it from scratch in their repo is how two
 * fakes drift apart. It reaches nothing but `./runner.ts`'s types.
 */

import type {ExecResult, Runner} from "./runner.ts";

/** One thing that happened, in the order it happened. The whole of what a test asserts on. */
export type Call =
	| {readonly kind: "exec"; readonly command: string; readonly cwd: string}
	| {readonly kind: "portFree"; readonly port: number}
	| {readonly kind: "read"; readonly path: string}
	| {readonly kind: "write"; readonly path: string; readonly contents: string}
	| {readonly kind: "exists"; readonly path: string};

export interface FakeRunner extends Runner {
	/** Every call, in order. The order *is* the provisioning contract. */
	readonly calls: ReadonlyArray<Call>;
	/** Just the command lines, which is what most assertions want. */
	readonly commands: () => ReadonlyArray<string>;
	/** What was written, by path. */
	readonly written: ReadonlyMap<string, string>;
}

export interface FakeOptions {
	/** Command lines that fail, mapped to the output they fail with. Everything else succeeds. */
	readonly failing?: Readonly<Record<string, string>>;
	/** Ports the OS refuses. Everything in range and not here is free. */
	readonly busy?: ReadonlyArray<number>;
	/** Files that exist, by path. A path not here reads `null` and does not exist. */
	readonly files?: Readonly<Record<string, string>>;
	/** Directories `exists` answers true for, on top of `files`. */
	readonly dirs?: ReadonlyArray<string>;
	/**
	 * Paths a write refuses, mapped to the detail it refuses with. Everything else is written.
	 * A refusal, never a rejection — a `Runner` that throws is the thing the port exists to forbid.
	 */
	readonly unwritable?: Readonly<Record<string, string>>;
}

export const fakeRunner = (options: FakeOptions = {}): FakeRunner => {
	const calls: Call[] = [];
	const written = new Map<string, string>();
	const failing = options.failing ?? {};
	const busy = options.busy ?? [];
	const files = options.files ?? {};
	const dirs = options.dirs ?? [];
	const unwritable = options.unwritable ?? {};

	const result = (command: string): ExecResult => {
		const failure = failing[command];
		return failure === undefined ? {ok: true, output: ""} : {ok: false, output: failure};
	};

	return {
		calls,
		written,
		commands: () => calls.flatMap((call) => (call.kind === "exec" ? [call.command] : [])),
		exec: async (command, cwd) => {
			calls.push({kind: "exec", command, cwd});
			return result(command);
		},
		portFree: async (port) => {
			calls.push({kind: "portFree", port});
			return !busy.includes(port);
		},
		readFile: async (path) => {
			calls.push({kind: "read", path});
			return files[path] ?? null;
		},
		writeFile: async (path, contents) => {
			calls.push({kind: "write", path, contents});
			const refusal = unwritable[path];
			if (refusal !== undefined) return {ok: false, detail: refusal};
			written.set(path, contents);
			return {ok: true, detail: ""};
		},
		exists: async (path) => {
			calls.push({kind: "exists", path});
			return dirs.includes(path) || files[path] !== undefined;
		},
	};
};
