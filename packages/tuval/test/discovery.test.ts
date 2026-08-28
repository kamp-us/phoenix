import {NodeServices} from "@effect/platform-node";
import {describe, expect, it} from "@effect/vitest";
import {Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {discoverPiSessions} from "../src/backend/pi-discovery.js";
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

					const first = yield* discoverPiSessions({sessionRoots: [root]});
					const second = yield* discoverPiSessions({sessionRoots: [root]});

					expect(() => decodeOutcome(first)).not.toThrow();
					expect(first._tag).toBe("partial-source");
					if (first._tag !== "partial-source" || second._tag !== "partial-source") return;
					expect(first.sessions).toHaveLength(1);
					expect(first.sessions[0]).toMatchObject({
						identity: "pi:filename-session",
						piSessionId: "filename-session",
						cwd: "/Users/test/project",
					});
					expect(second.sessions[0]?.identity).toBe(first.sessions[0]?.identity);
					expect(first.problems).toEqual([
						expect.objectContaining({message: "session header is not valid JSON"}),
					]);
				}),
		);

		it.effect("distinguishes empty, fatal, and framed transport failures", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-discovery-"});
				const empty = yield* discoverPiSessions({sessionRoots: [path.join(root, "missing")]});
				expect(() => decodeOutcome(empty)).not.toThrow();
				expect(empty).toEqual({_tag: "empty", sessions: []});

				const notDirectory = path.join(root, "not-a-directory");
				yield* fs.writeFileString(notDirectory, "x");
				const fatal = yield* discoverPiSessions({sessionRoots: [notDirectory]});
				expect(() => decodeOutcome(fatal)).not.toThrow();
				expect(fatal).toMatchObject({_tag: "fatal"});

				const transport = yield* discoverPiSessions({
					sessionRoots: [path.join(root, "missing")],
					transport: {failWith: new Error("synthetic transport break")},
				});
				expect(() => decodeOutcome(transport)).not.toThrow();
				expect(transport).toEqual({
					_tag: "transport",
					message: "synthetic transport break",
					retryable: true,
				});
			}),
		);
	});
});
