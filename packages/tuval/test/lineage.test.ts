import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Path, Result, Schema} from "effect";
import fc from "fast-check";
import {defaultLineageOptions, loadLineageStore, refreshLineage} from "../src/backend/lineage.js";
import {sessionIdentity} from "../src/shared/discovery.js";
import {
	emptyLineageStore,
	LineageProjection,
	type LineageRecords,
	upsertLineageRecords,
} from "../src/shared/lineage.js";

const sessionHeader = (input: {
	readonly id: string;
	readonly cwd?: string;
	readonly parentSession?: string;
}) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id: input.id,
		timestamp: "2026-08-27T12:00:00.000Z",
		cwd: input.cwd ?? "/tmp/tuval",
		...(input.parentSession === undefined ? {} : {parentSession: input.parentSession}),
	});

const writeSession = Effect.fn("LineageTest.writeSession")(function* (
	root: string,
	relativePath: string,
	input: {readonly id: string; readonly parentSession?: string; readonly body?: string},
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = path.join(root, relativePath);
	yield* fs.makeDirectory(path.dirname(target), {recursive: true});
	yield* fs.writeFileString(
		target,
		`${sessionHeader(input)}\n${input.body ?? JSON.stringify({type: "message"})}\n`,
	);
	return target;
});

const writeStatus = Effect.fn("LineageTest.writeStatus")(function* (
	root: string,
	name: string,
	status: unknown,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(root, name);
	yield* fs.makeDirectory(directory, {recursive: true});
	const target = path.join(directory, "status.json");
	yield* fs.writeFileString(target, JSON.stringify(status));
	return target;
});

const edgeKinds = (graph: {readonly edges: ReadonlyArray<{readonly kind: string}>}) =>
	graph.edges.map((edge) => edge.kind).sort();

describe("Tuval lineage index", () => {
	it.layer(NodeServices.layer)((it) => {
		it.effect("joins top-level and nested runs while preferring protocol fork metadata", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "tuval", "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "root/run-0/session.jsonl", {
					id: "child",
					parentSession: parentFile,
				});
				const nestedFile = yield* writeSession(sessionsRoot, "root/nested/session.jsonl", {
					id: "nested",
					parentSession: parentFile,
					body: `${"x".repeat(256 * 1024)} not-json {"parentSessionId":"body-parent"}`,
				});
				yield* writeStatus(runsRoot, "root-run", {
					lifecycleArtifactVersion: 3,
					runId: "wrapper-run",
					sessionId: parentFile,
					startedAt: 100,
					steps: [
						{
							runId: "child-run",
							parentWorkflowRunId: "wrapper-run",
							sessionFile: childFile,
							startedAt: 110,
							children: [
								{
									id: "nested-run",
									parentRunId: "child-run",
									sessionFile: nestedFile,
									startedAt: 120,
								},
							],
						},
					],
				});

				const first = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
					protocolSessions: [
						{id: "parent", createdAt: 1, cwd: "/tmp/tuval"},
						{id: "child", createdAt: 2, cwd: "/tmp/tuval"},
						{id: "nested", createdAt: 3, parentSessionId: "child", cwd: "/tmp/tuval"},
					],
				});
				const second = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
					protocolSessions: [
						{id: "parent", createdAt: 1},
						{id: "child", createdAt: 2},
						{id: "nested", createdAt: 3, parentSessionId: "child"},
					],
				});

				assert.doesNotThrow(() => Schema.decodeUnknownSync(LineageProjection)(first));
				assert.deepEqual(second.graph, first.graph);
				assert.deepEqual(
					first.graph.nodes.map((node) => node.piSessionId),
					["child", "nested", "parent"],
				);
				assert.deepEqual(edgeKinds(first.graph), ["fork", "fork", "spawn", "spawn"]);
				assert.deepInclude(
					first.graph.edges.find((edge) => edge.id === "spawn:child-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child")},
				);
				assert.deepInclude(
					first.graph.edges.find((edge) => edge.id === "spawn:nested-run"),
					{parent: sessionIdentity("child"), child: sessionIdentity("nested")},
				);
				assert.deepInclude(
					first.graph.edges.find(
						(edge) => edge.kind === "fork" && edge.child === sessionIdentity("child"),
					),
					{parent: sessionIdentity("parent"), source: "header"},
				);
				const nestedFork = first.graph.edges.find(
					(edge) => edge.kind === "fork" && edge.child === sessionIdentity("nested"),
				);
				assert.deepInclude(nestedFork, {
					kind: "fork",
					parent: sessionIdentity("child"),
					source: "protocol",
				});
				assert.lengthOf(first.problems, 0);
			}),
		);

		it.effect("records reopen continuity without a second spawn and survives retention loss", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-retention-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "store", "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child/session.jsonl", {id: "child"});
				for (const [name, runId, startedAt] of [
					["first", "first-child-run", 100],
					["reopen", "reopened-child-run", 200],
				] as const) {
					yield* writeStatus(runsRoot, name, {
						runId: `${name}-wrapper`,
						sessionId: parentFile,
						startedAt,
						steps: [{runId, sessionFile: childFile, startedAt}],
					});
				}

				const indexed = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.lengthOf(
					indexed.graph.edges.filter((edge) => edge.kind === "spawn"),
					1,
				);
				assert.deepEqual(indexed.graph.continuity, [
					{
						id: "resume:reopened-child-run",
						runId: "reopened-child-run",
						session: sessionIdentity("child"),
						observedAt: 200,
					},
				]);
				const before = yield* fs.readFileString(storePath);
				yield* fs.remove(sessionsRoot, {recursive: true});
				const retainedRuns = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepEqual(retainedRuns.graph, indexed.graph);
				assert.lengthOf(retainedRuns.problems, 0);
				yield* fs.remove(runsRoot, {recursive: true});

				const restored = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				const after = yield* fs.readFileString(storePath);
				assert.strictEqual(after, before);
				assert.deepEqual(restored.graph, indexed.graph);
			}),
		);

		it.effect("indexes status-level runs and records a later revival as continuity", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-status-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "single", {
					runId: "single-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 100,
				});
				yield* writeStatus(runsRoot, "revival", {
					runId: "revival-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 200,
				});

				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					projected.graph.edges.find((edge) => edge.id === "spawn:single-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child")},
				);
				assert.deepEqual(projected.graph.continuity, [
					{
						id: "resume:revival-run",
						runId: "revival-run",
						session: sessionIdentity("child"),
						observedAt: 200,
					},
				]);
			}),
		);

		it.effect("keeps authoritative missing parents unresolved instead of using the wrapper", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-parent-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "missing-parent", {
					runId: "wrapper",
					sessionId: parentFile,
					steps: [
						{
							runId: "child-run",
							parentRunId: "missing-run",
							sessionFile: childFile,
							startedAt: 10,
						},
					],
				});

				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.lengthOf(
					projected.graph.edges.filter((edge) => edge.kind === "spawn"),
					0,
				);
				assert.isTrue(
					projected.problems.some((problem) =>
						problem.message.includes("Authoritative parent run missing-run"),
					),
				);
			}),
		);

		it.effect("reclassifies a retained later origin when an earlier artifact is restored", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-order-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "later", {
					runId: "later-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 200,
				});
				yield* refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath});
				yield* writeStatus(runsRoot, "earlier", {
					runId: "earlier-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 100,
				});

				const restored = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.isDefined(restored.graph.edges.find((edge) => edge.id === "spawn:earlier-run"));
				assert.isUndefined(restored.graph.edges.find((edge) => edge.id === "spawn:later-run"));
				assert.isDefined(
					restored.graph.continuity.find((value) => value.id === "resume:later-run"),
				);
				const bytes = yield* fs.readFileString(storePath);
				yield* refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath});
				assert.strictEqual(yield* fs.readFileString(storePath), bytes);
			}),
		);

		it.effect("diagnoses empty statuses and malformed nested entries", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-malformed-"});
				const runsRoot = path.join(root, "runs");
				const sessionsRoot = path.join(root, "sessions");
				yield* writeStatus(runsRoot, "empty", {});
				yield* writeStatus(runsRoot, "nested", {runId: "wrapper", steps: [{}]});
				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});
				assert.deepEqual(
					projected.problems.map((problem) => problem.code),
					["malformed-run", "malformed-run"],
				);
			}),
		);

		it.effect("refuses a changed observation for a persisted run id", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-rewrite-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const statusPath = yield* writeStatus(runsRoot, "run", {
					runId: "stable-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 10,
				});
				yield* refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath});
				yield* fs.writeFileString(
					statusPath,
					JSON.stringify({
						runId: "stable-run",
						sessionId: parentFile,
						sessionFile: childFile,
						startedAt: 11,
					}),
				);
				const rewritten = yield* Effect.result(
					refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath}),
				);
				assert.isTrue(Result.isFailure(rewritten));
				if (Result.isFailure(rewritten)) {
					assert.strictEqual(rewritten.failure._tag, "tuval/LineageConflictError");
				}
			}),
		);

		it.effect("serializes concurrent projections without losing either update", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-concurrent-"});
				const sessionsRoot = path.join(root, "sessions");
				const storePath = path.join(root, "store", "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const alphaFile = yield* writeSession(sessionsRoot, "alpha.jsonl", {id: "alpha"});
				const betaFile = yield* writeSession(sessionsRoot, "beta.jsonl", {id: "beta"});
				const roots = [path.join(root, "alpha-runs"), path.join(root, "beta-runs")];
				yield* writeStatus(roots[0] as string, "run", {
					runId: "alpha-run",
					sessionId: parentFile,
					sessionFile: alphaFile,
					startedAt: 10,
				});
				yield* writeStatus(roots[1] as string, "run", {
					runId: "beta-run",
					sessionId: parentFile,
					sessionFile: betaFile,
					startedAt: 20,
				});
				yield* Effect.all(
					roots.map((runRoot) =>
						refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath}),
					),
					{concurrency: "unbounded"},
				);
				const stored = yield* loadLineageStore(storePath);
				assert.deepEqual(
					stored.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.runId),
					["alpha-run", "beta-run"],
				);
				const storeEntries = yield* fs.readDirectory(path.dirname(storePath));
				assert.deepEqual(storeEntries, ["lineage.json"]);
			}),
		);

		it.effect("refuses duplicate and dangling records in a shape-valid durable store", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-store-"});
				const storePath = path.join(root, "lineage.json");
				const node = {
					id: sessionIdentity("a"),
					piSessionId: "a",
					createdAt: 1,
					updatedAt: 1,
					cwd: "/tmp",
					sourceFiles: ["/tmp/a.jsonl"],
				};
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({version: 1, nodes: [node, node], edges: [], continuity: []}),
				);
				const duplicate = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(duplicate));
				if (Result.isFailure(duplicate)) {
					assert.strictEqual(duplicate.failure._tag, "tuval/LineageConflictError");
				}
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 1,
						nodes: [
							node,
							{
								...node,
								id: sessionIdentity("b"),
								piSessionId: "b",
							},
						],
						edges: [],
						continuity: [],
					}),
				);
				const sourceConflict = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(sourceConflict));
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 1,
						nodes: [node],
						edges: [
							{
								id: "spawn:r",
								kind: "spawn",
								parent: sessionIdentity("missing"),
								child: node.id,
								runId: "r",
								observedAt: 1,
							},
						],
						continuity: [],
					}),
				);
				const dangling = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(dangling));
			}),
		);

		it.effect("uses discovery's configured environment roots by default", () =>
			Effect.gen(function* () {
				const direct = yield* defaultLineageOptions(
					{},
					{PI_CODING_AGENT_SESSION_DIR: "/configured/sessions"},
					"/home/tuval",
					"/tmp",
				);
				assert.deepEqual(direct.sessionRoots, ["/configured/sessions"]);
				const agent = yield* defaultLineageOptions(
					{},
					{PI_CODING_AGENT_DIR: "/configured/agent"},
					"/home/tuval",
					"/tmp",
				);
				assert.deepEqual(agent.sessionRoots, ["/configured/agent/sessions"]);
			}),
		);

		it.effect("isolates torn sources and refuses conflicts and unknown store versions", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-errors-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				yield* fs.makeDirectory(sessionsRoot, {recursive: true});
				yield* fs.writeFileString(path.join(sessionsRoot, "torn.jsonl"), '{"type":"session"');
				yield* fs.makeDirectory(path.join(runsRoot, "torn"), {recursive: true});
				yield* fs.writeFileString(path.join(runsRoot, "torn", "status.json"), '{"runId":');

				const partial = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepEqual(partial.problems.map((problem) => problem.code).sort(), [
					"malformed-run",
					"malformed-session",
				]);

				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const alphaFile = yield* writeSession(sessionsRoot, "alpha/session.jsonl", {id: "alpha"});
				const betaFile = yield* writeSession(sessionsRoot, "beta/session.jsonl", {id: "beta"});
				yield* writeStatus(runsRoot, "conflict-a", {
					runId: "wrapper-a",
					sessionId: parentFile,
					steps: [{runId: "same-run", sessionFile: alphaFile, startedAt: 10}],
				});
				yield* writeStatus(runsRoot, "conflict-b", {
					runId: "wrapper-b",
					sessionId: parentFile,
					steps: [{runId: "same-run", sessionFile: betaFile, startedAt: 11}],
				});
				const conflict = yield* Effect.result(
					refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath}),
				);
				assert.isTrue(Result.isFailure(conflict));
				if (Result.isFailure(conflict))
					assert.strictEqual(conflict.failure._tag, "tuval/LineageConflictError");

				yield* fs.writeFileString(
					storePath,
					'{"version":99,"nodes":[],"edges":[],"continuity":[]}\n',
				);
				const version = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(version));
				if (Result.isFailure(version))
					assert.strictEqual(version.failure._tag, "tuval/LineageStoreVersionError");
			}),
		);
	});

	it("upserts exact observations idempotently for arbitrary repetition and order", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), {maxLength: 30}),
				fc.array(fc.nat({max: 10}), {maxLength: 100}),
				(runIds, order) => {
					const parent = {
						id: sessionIdentity("property-parent"),
						piSessionId: "property-parent",
						createdAt: 0,
						updatedAt: 0,
						cwd: "/tmp/tuval",
						sourceFiles: [],
					};
					const children = runIds.map((runId, index) => ({
						id: sessionIdentity(runId),
						piSessionId: runId,
						createdAt: index + 1,
						updatedAt: index + 1,
						cwd: "/tmp/tuval",
						sourceFiles: [],
					}));
					const records: LineageRecords = {
						nodes: [parent, ...children],
						edges: children.map((node, index) => ({
							id: `spawn:${runIds[index] as string}`,
							kind: "spawn" as const,
							parent: parent.id,
							child: node.id,
							runId: runIds[index] as string,
							observedAt: index,
						})),
						continuity: children.map((node, index) => ({
							id: `resume:resume-${runIds[index] as string}`,
							runId: `resume-${runIds[index] as string}`,
							session: node.id,
							observedAt: index + 100,
						})),
					};
					let graph = emptyLineageStore();
					for (const index of order) {
						const node = records.nodes[index % Math.max(1, records.nodes.length)];
						if (node === undefined) continue;
						const next = upsertLineageRecords(graph, {nodes: [node], edges: [], continuity: []});
						if (Result.isFailure(next)) return false;
						graph = next.success;
					}
					const all = upsertLineageRecords(graph, records);
					if (Result.isFailure(all)) return false;
					const repeated = upsertLineageRecords(all.success, records);
					return (
						Result.isSuccess(repeated) &&
						JSON.stringify(repeated.success) === JSON.stringify(all.success)
					);
				},
			),
		);
	});
});
