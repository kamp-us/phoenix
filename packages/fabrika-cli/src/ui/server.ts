/**
 * The impure harness leg: start the repo's own dev-server command, wait for it to answer, and hand
 * back the killer `ui render` runs on every exit path.
 *
 * The command is the repo's declaration (`design-harness.json`), never this package's knowledge of
 * any stack — that is what makes the group portable. The process is started in its own group and
 * killed by group, because a dev server is habitually a wrapper that spawns the real listener: kill
 * the wrapper alone and the port stays held for the next lane.
 */
import {spawn} from "node:child_process";
import {Effect} from "effect";
import {type HarnessConfig, READY_TIMEOUT_MS} from "./harness.ts";
import {legFailed} from "./leg-failed.ts";
import type {HarnessLeg, HarnessStart} from "./render-verb.ts";

const POLL_INTERVAL_MS = 500;
/** How much of the server's own stderr rides along in the not-ready refusal. */
const TAIL_LIMIT = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const answers200 = (url: string): Promise<boolean> =>
	fetch(url, {redirect: "follow"}).then(
		(response) => response.status === 200,
		() => false,
	);

export const spawnHarness: HarnessLeg = (config: HarnessConfig, root: string) =>
	Effect.tryPromise({
		try: async (): Promise<HarnessStart> => {
			let stderr = "";
			const child = spawn(config.command, {cwd: root, shell: true, detached: true});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = `${stderr}${chunk.toString("utf8")}`.slice(-TAIL_LIMIT);
			});
			let spawnFailure: string | null = null;
			child.on("error", (err) => {
				spawnFailure = err.message;
			});
			// Kill the whole group, then fall back to the child alone: a `process.kill(-pid)` on a child
			// that never became a group leader throws, and losing the fallback would leak the server.
			const stop = Effect.try({
				try: () => {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
				},
				catch: legFailed,
			}).pipe(Effect.catch(() => Effect.sync(() => void child.kill("SIGTERM"))));

			const deadline = Date.now() + READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (spawnFailure !== null) return {_tag: "Failed", reason: spawnFailure};
				if (child.exitCode !== null) {
					return {
						_tag: "Failed",
						reason: `the command exited with ${child.exitCode}: ${stderr.trim()}`,
					};
				}
				if (await answers200(`${config.url}${config.readyPath}`)) return {_tag: "Ready", stop};
				await sleep(POLL_INTERVAL_MS);
			}
			await Effect.runPromise(stop);
			return {_tag: "NotReady", tail: stderr.trim()};
		},
		catch: legFailed,
	}).pipe(
		Effect.catch((cause) => Effect.succeed<HarnessStart>({_tag: "Failed", reason: cause.reason})),
	);
