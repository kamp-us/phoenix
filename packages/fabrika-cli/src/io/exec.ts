/**
 * The one subprocess seam — plain node, no `effect` import, so the native `try/catch` a
 * non-zero-exit-is-data call needs is the correct shape here rather than a banned one (#2736).
 *
 * Every caller reads `ok` before `stdout`. That is the whole discipline this file exists to make
 * unavoidable: a failed invocation returns empty `stdout`, and empty `stdout` is byte-identical to
 * a successful invocation that found nothing. Interpreting bytes without first reading the status
 * is how a check comes to answer a plausible value instead of an error.
 */
import {execFileSync} from "node:child_process";

export interface ExecResult {
	readonly ok: boolean;
	readonly stdout: string;
	/** The first line of stderr, or the thrown message — enough to quote in a refusal. */
	readonly reason: string;
}

/** How a command is run. Injectable so every verb's failure path is testable without a subprocess. */
export type Exec = (file: string, args: ReadonlyArray<string>) => ExecResult;

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim() !== "") ?? "").trim();

/** Run a command, capturing stdout; a non-zero exit is data, never a throw. */
export const execCapture: Exec = (file, args) => {
	try {
		const stdout = execFileSync(file, [...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
		return {ok: true, stdout, reason: ""};
	} catch (err) {
		const e: {stderr?: string | Buffer; message?: string} =
			typeof err === "object" && err !== null ? err : {};
		const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
		return {
			ok: false,
			stdout: "",
			reason: firstLine(stderr) || firstLine(e.message ?? "") || "failed",
		};
	}
};
