/**
 * The one place this package touches the machine — and the reason it is one place.
 *
 * Provisioning is `git worktree add`, a TCP bind, a file read, a file write and a handful of shell
 * commands somebody else wrote. Every one of those is a thing a test must not do: a suite that runs
 * `git worktree add` leaves worktrees behind when it fails, and a suite that binds a port is a
 * suite that fails on a laptop with a dev server up. So the program never calls any of them. It
 * calls a `Runner`, and `nodeRunner()` is the one implementation that is really the machine —
 * handed in by the config, replaced by a recording fake in every test in this package.
 *
 * This is the same injection cron makes for `now`, one size up: a clock is a function, a machine is
 * five of them.
 */

import {exec as execCallback} from "node:child_process";
import {access, readFile, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {promisify} from "node:util";

const execAsync = promisify(execCallback);

/** What a command did: whether it worked, and the text worth showing a person if it did not. */
export interface ExecResult {
	readonly ok: boolean;
	/** stdout and stderr together, trimmed — one field, because a tile shows one line of it. */
	readonly output: string;
}

/**
 * What a write did: whether the bytes landed, and why not when they did not.
 *
 * A write answers rather than throwing for the same reason `exec` and `readFile` do — **every
 * method on this port is total**. A `Runner` that rejects instead of answering does not fail a
 * provision, it *kills* it: the program is a fiber, a rejected promise inside `Effect.promise` is
 * a defect, and a defect means the provisioning handler dispatches nothing, `pending` never clears,
 * and every later open and close is refused "busy" until the process restarts. So the port refuses
 * to offer that shape at all.
 */
export interface WriteResult {
	readonly ok: boolean;
	/** Why the write did not land — empty when it did. */
	readonly detail: string;
}

/**
 * Everything this package asks of the world. Five methods and no sixth: each one is a thing
 * provisioning genuinely does, and a wider port would be a wider thing to fake. **None of them
 * throws** — see `WriteResult` for what a throwing one costs.
 */
export interface Runner {
	/** Run a shell command line in a directory, and say how it went. Never throws. */
	readonly exec: (command: string, cwd: string) => Promise<ExecResult>;
	/** Can this TCP port be bound on the loopback right now? */
	readonly portFree: (port: number) => Promise<boolean>;
	/** The file's text, or `null` when it is not there. Never throws for a missing file. */
	readonly readFile: (path: string) => Promise<string | null>;
	/** Write the file, and say how it went. Never throws. */
	readonly writeFile: (path: string, contents: string) => Promise<WriteResult>;
	/** Is there something at this path? The whole of what reconcile asks. */
	readonly exists: (path: string) => Promise<boolean>;
}

/** How long a single setup or teardown command may take before it is called failed. */
export const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The real machine. A shell is used deliberately — `setup` and `teardown` are command *lines* a
 * person wrote in a config (`docker compose -p x up -d --wait`), so pretending they are argv
 * vectors would mean this package parsing shell quoting, which it would get wrong.
 *
 * Which also means: **a setup command runs with your user's authority, unsandboxed**, like every
 * other line of a Tuval config. The README says so where a person installing this will read it.
 */
export const nodeRunner = (): Runner => ({
	exec: async (command, cwd) => {
		try {
			const {stdout, stderr} = await execAsync(command, {
				cwd,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
			});
			return {ok: true, output: `${stdout}${stderr}`.trim()};
		} catch (cause) {
			return {ok: false, output: messageOf(cause)};
		}
	},

	/**
	 * A bind, released immediately. There is no way to ask an OS "is this port free" that is not a
	 * bind, and the race between this answer and the dev server that later takes the port is real
	 * and unclosable — the honest mitigation is that the program also skips ports it has already
	 * handed out, which `takenPorts` is.
	 */
	portFree: (port) =>
		new Promise((resolve) => {
			const server = createServer();
			server.once("error", () => resolve(false));
			server.once("listening", () => server.close(() => resolve(true)));
			server.listen(port, "127.0.0.1");
		}),

	readFile: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch {
			return null;
		}
	},

	writeFile: async (path, contents) => {
		try {
			await writeFile(path, contents, "utf8");
			return {ok: true, detail: ""};
		} catch (cause) {
			return {ok: false, detail: messageOf(cause)};
		}
	},

	exists: async (path) => {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	},
});

const messageOf = (cause: unknown): string => {
	if (cause instanceof Error) {
		// `child_process`' error carries the command's own output, which is the useful half.
		const withOutput = cause as Error & {
			readonly stdout?: string;
			readonly stderr?: string;
		};
		const output = `${withOutput.stdout ?? ""}${withOutput.stderr ?? ""}`.trim();
		return output === "" ? cause.message : output;
	}
	return String(cause);
};
