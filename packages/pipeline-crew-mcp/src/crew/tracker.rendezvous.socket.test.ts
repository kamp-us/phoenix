/**
 * The end-to-end proof of ADR 0197 over the REAL socket: two peers of one repo seeded from DIFFERENT
 * cwds — the repo root and a nested `apps/web` — meet at one live registry, so the peer announced by
 * the first is discoverable by the second.
 *
 * This is the regression test for the failure the rewrite exists to kill. Under the old cwd-derived
 * hashing these two seeds produced two sockets and two disjoint registries: each peer registered
 * successfully, saw an empty lookup, and was indistinguishable from a peer that was simply alone.
 *
 * `it.live`, not `it.effect`: this binds a real unix socket and settles it with a real `Effect.sleep`,
 * which the virtual TestClock would never advance.
 */
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {resolveRendezvous} from "../tracker/index.ts";
import {CrewTracker, crewTrackerHostOrDialLayer} from "./tracker.ts";

const hostOrDial = (socketPath: string) =>
	crewTrackerHostOrDialLayer(socketPath).pipe(Layer.provide(NodeFileSystem.layer));

describe("crew rendezvous — two cwds of one repo, one live registry", () => {
	it.live("a peer announced from the repo root is discovered from a nested subdir", () =>
		Effect.gen(function* () {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "rendezvous-e2e-")));
			execFileSync("git", ["init", "-q", "-b", "main", root]);
			const nested = join(root, "apps", "web");
			mkdirSync(nested, {recursive: true});

			const fromRoot = yield* resolveRendezvous(root);
			const fromNested = yield* resolveRendezvous(nested);
			assert.strictEqual(fromNested.socketPath, fromRoot.socketPath);

			yield* Effect.scoped(
				Effect.gen(function* () {
					// The root-seeded peer wins the bind and hosts the registry for the repo.
					const hostContext = yield* Layer.build(hostOrDial(fromRoot.socketPath));
					yield* Effect.sleep("300 millis"); // let the socket server bind + listen
					yield* Context.get(hostContext, CrewTracker).announce({
						role: "engineering-manager",
						peer: "inbox://engineering-manager",
						address: "inbox://engineering-manager",
					});

					// The nested-seeded peer resolves the SAME socket, so its bind loses with EADDRINUSE and
					// it dials the host — the convergence the old hashing broke.
					const dialContext = yield* Layer.build(hostOrDial(fromNested.socketPath));
					const found = yield* Context.get(dialContext, CrewTracker).lookup("engineering-manager");

					assert.strictEqual(found.length, 1);
					assert.strictEqual(found[0]?.address, "inbox://engineering-manager");
				}),
			);

			rmSync(root, {recursive: true, force: true});
		}),
	);
});
