import {homedir} from "node:os";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {discoverPiSessionMetadata, discoverPiSessions} from "../src/backend/pi-discovery.js";
import {defaultSessionRoots, sessionIdFromFilename} from "../src/backend/pi-home.js";
import {makeDiscoveryTransport} from "../src/backend/pi-protocol.js";
import {DiscoveryOutcome} from "../src/shared/discovery.js";

const decodeOutcome = Schema.decodeUnknownSync(DiscoveryOutcome);

describe("pi home discovery", () => {
	it.layer(NodeServices.layer)((it) => {
		it.effect(
			"discovers controlled homes with stable identities and isolates malformed sessions",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-discovery-"});
					const project = path.join(root, "--Users-test-project");
					yield* fs.makeDirectory(project);
					yield* fs.writeFileString(
						path.join(project, "2026-08-27T12-00-00-000Z_filename-session.jsonl"),
						`${JSON.stringify({
							type: "session",
							version: 3,
							id: "copied-header-id",
							timestamp: "2026-08-27T12:00:00.000Z",
							cwd: "/Users/test/project",
						})}\n${JSON.stringify({type: "message", content: "x".repeat(1024 * 1024)})}\n`,
					);
					yield* fs.writeFileString(
						path.join(project, "2026-08-27T12-01-00-000Z_broken.jsonl"),
						"not-json\n",
					);
					const outside = yield* fs.makeTempDirectoryScoped({prefix: "tuval-linked-session-"});
					const linkedTarget = path.join(outside, "2026-08-27T12-02-00-000Z_linked.jsonl");
					yield* fs.writeFileString(
						linkedTarget,
						`${JSON.stringify({type: "session", id: "linked", cwd: "/linked"})}\n`,
					);
					yield* fs.symlink(
						linkedTarget,
						path.join(project, "2026-08-27T12-02-00-000Z_linked.jsonl"),
					);

					const first = yield* discoverPiSessions({sessionRoots: [root]});
					const second = yield* discoverPiSessions({sessionRoots: [root]});

					assert.doesNotThrow(() => decodeOutcome(first));
					assert.strictEqual(first._tag, "partial-source");
					if (first._tag !== "partial-source" || second._tag !== "partial-source") return;
					assert.lengthOf(first.sessions, 1);
					assert.strictEqual(first.sessions[0]?.identity, "pi:filename-session");
					assert.strictEqual(first.sessions[0]?.piSessionId, "filename-session");
					assert.strictEqual(first.sessions[0]?.cwd, "/Users/test/project");
					assert.strictEqual(second.sessions[0]?.identity, first.sessions[0]?.identity);
					assert.strictEqual(first.problems[0]?.message, "session header is not valid JSON");
				}),
		);

		it.effect("distinguishes protocol metadata availability, absence, and failure", () =>
			Effect.gen(function* () {
				const authoritative = [
					{
						id: "child",
						createdAt: 2,
						parentSessionId: "protocol-parent",
						cwd: "/tmp/project",
					},
				];
				assert.deepEqual(yield* discoverPiSessionMetadata(), {_tag: "not-configured"});
				assert.deepEqual(
					yield* discoverPiSessionMetadata({
						protocolTransport: makeDiscoveryTransport(authoritative),
					}),
					{_tag: "available", sessions: authoritative},
				);
				assert.deepEqual(
					yield* discoverPiSessionMetadata({
						protocolTransport: makeDiscoveryTransport([], {
							failWith: new Error("metadata transport unavailable"),
						}),
					}),
					{_tag: "failed", message: "metadata transport unavailable"},
				);
			}),
		);

		it.effect("falls back to the OS home when pi directory variables are absent", () =>
			Effect.gen(function* () {
				const path = yield* Path.Path;
				assert.deepEqual(yield* defaultSessionRoots({}), [
					path.join(homedir(), ".pi", "agent", "sessions"),
				]);
			}),
		);

		it.effect("distinguishes empty, fatal, and framed transport failures", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-discovery-"});
				const empty = yield* discoverPiSessions({sessionRoots: [path.join(root, "missing")]});
				assert.doesNotThrow(() => decodeOutcome(empty));
				assert.deepEqual(empty, {_tag: "empty", sessions: []});

				const notDirectory = path.join(root, "not-a-directory");
				yield* fs.writeFileString(notDirectory, "x");
				const fatal = yield* discoverPiSessions({sessionRoots: [notDirectory]});
				assert.doesNotThrow(() => decodeOutcome(fatal));
				assert.deepInclude(fatal, {_tag: "fatal"});

				const transport = yield* discoverPiSessions({
					sessionRoots: [path.join(root, "missing")],
					transport: {failWith: new Error("synthetic transport break")},
				});
				assert.doesNotThrow(() => decodeOutcome(transport));
				assert.deepEqual(transport, {
					_tag: "transport",
					message: "synthetic transport break",
					retryable: true,
				});
			}),
		);
	});

	it("derives standard identity from the final filename on POSIX and Windows paths", () => {
		assert.strictEqual(
			sessionIdFromFilename("/tmp/parent_with_underscore/2026-08-27T12-00-00-000Z_child.jsonl"),
			"child",
		);
		assert.strictEqual(
			sessionIdFromFilename(
				"C:\\Users\\parent_with_underscore\\2026-08-27T12-00-00-000Z_child.jsonl",
			),
			"child",
		);
		assert.isUndefined(sessionIdFromFilename("C:\\Users\\parent_with_underscore\\session.jsonl"));
	});
});
