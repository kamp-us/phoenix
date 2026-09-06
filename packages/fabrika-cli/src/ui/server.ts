/**
 * The impure harness leg: start every app a render needs, each on a freshly allocated free port,
 * wait for each to answer its own `readyPath`, and hand back the killer `ui render` runs on every
 * exit path.
 *
 * The commands are the repo's declaration (`design-harness.json`), never this package's knowledge of
 * any stack — that is what makes the group portable. Each process is started in its own group and
 * killed by group, because a dev server is habitually a wrapper that spawns the real listener: kill
 * the wrapper alone and the port stays held for the next lane.
 *
 * Ports are allocated here rather than declared, so two worktrees can render at once and neither can
 * reach the other's server (#7992). The allocation binds `:0`, reads the port the OS chose and lets
 * go, and the origin every capture is taken from is built from that number — so a declared command
 * **must** pass the port with its own strict-port flag. Losing the race then fails the start loudly;
 * a server that falls back to the next free port instead leaves the origin pointing at whatever else
 * answers there, and the readiness probe cannot tell that apart from its own server. An app whose
 * command cannot be made strict is left undeclared.
 */
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {Effect} from "effect";
import {fillPorts, type HarnessApp, portTokens, READY_TIMEOUT_MS} from "./harness.ts";
import {legFailed} from "./leg-failed.ts";
import type {HarnessLeg, HarnessStart} from "./render-verb.ts";

const POLL_INTERVAL_MS = 500;
/** How much of a server's own stderr rides along in the not-ready refusal. */
const TAIL_LIMIT = 2000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const answers200 = (url: string): Promise<boolean> =>
	fetch(url, {redirect: "follow"}).then(
		(response) => response.status === 200,
		() => false,
	);

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, () => {
			const address = probe.address();
			if (address === null || typeof address === "string") {
				probe.close(() => reject(new Error("the OS named no port for the probe socket")));
				return;
			}
			const {port} = address;
			probe.close(() => resolve(port));
		});
	});

interface Started {
	readonly app: HarnessApp;
	readonly origin: string;
	readonly readyUrl: string;
	readonly stop: Effect.Effect<void>;
	readonly exited: () => number | null;
	readonly spawnFailure: () => string | null;
	readonly tail: () => string;
}

const start = async (app: HarnessApp, root: string): Promise<Started> => {
	const ports = new Map<string, number>();
	for (const token of portTokens(app.command)) ports.set(token, await freePort());
	// `localhost`, not `127.0.0.1`: a dev server that binds only `::1` is unreachable by the literal
	// v4 address, and vite is one — the name lets the client try both families.
	const origin = `http://localhost:${ports.get("")}`;
	let stderr = "";
	let spawnFailure: string | null = null;
	const child = spawn(fillPorts(app.command, ports), {cwd: root, shell: true, detached: true});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-TAIL_LIMIT);
	});
	child.on("error", (err) => {
		spawnFailure = err.message;
	});
	return {
		app,
		origin,
		readyUrl: `${origin}${app.readyPath}`,
		// Kill the whole group, then fall back to the child alone: a `process.kill(-pid)` on a child
		// that never became a group leader throws, and losing the fallback would leak the server.
		stop: Effect.try({
			try: () => {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
			},
			catch: legFailed,
		}).pipe(Effect.catch(() => Effect.sync(() => void child.kill("SIGTERM")))),
		exited: () => child.exitCode,
		spawnFailure: () => spawnFailure,
		tail: () => stderr.trim(),
	};
};

export const spawnHarness: HarnessLeg = (apps: ReadonlyArray<HarnessApp>, root: string) =>
	Effect.tryPromise({
		try: async (): Promise<HarnessStart> => {
			const started: Array<Started> = [];
			const stopAll = Effect.suspend(() =>
				Effect.forEach(started, (one) => one.stop, {concurrency: 1, discard: true}),
			);
			for (const app of apps) started.push(await start(app, root));

			const pending = new Map(started.map((one) => [one.app.name, one]));
			const deadline = Date.now() + READY_TIMEOUT_MS;
			while (Date.now() < deadline && pending.size > 0) {
				for (const one of [...pending.values()]) {
					const failure = one.spawnFailure();
					if (failure !== null) {
						await Effect.runPromise(stopAll);
						return {_tag: "Failed", app: one.app.name, reason: failure};
					}
					if (one.exited() !== null) {
						await Effect.runPromise(stopAll);
						return {
							_tag: "Failed",
							app: one.app.name,
							reason: `the command exited with ${one.exited()}: ${one.tail()}`,
						};
					}
					if (await answers200(one.readyUrl)) pending.delete(one.app.name);
				}
				if (pending.size > 0) await sleep(POLL_INTERVAL_MS);
			}

			const [stuck] = pending.values();
			if (stuck !== undefined) {
				await Effect.runPromise(stopAll);
				return {
					_tag: "NotReady",
					app: stuck.app.name,
					readyPath: stuck.app.readyPath,
					tail: stuck.tail(),
				};
			}
			return {
				_tag: "Ready",
				origins: new Map(started.map((one) => [one.app.name, one.origin])),
				stop: stopAll,
			};
		},
		catch: legFailed,
	}).pipe(
		Effect.catch((cause) =>
			// The leg itself threw, so no app owns the failure — the refusal reads `app "the render leg"
			// could not start`, which is what happened, rather than a placeholder that reads as a bug in
			// the message.
			Effect.succeed<HarnessStart>({_tag: "Failed", app: "the render leg", reason: cause.reason}),
		),
	);
