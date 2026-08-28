import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, FileSystem, Path, Result, Schema} from "effect";
import fc from "fast-check";
import {
	defaultLineageOptions,
	loadLineageStore,
	refreshLineage,
	resolvePiSubagentsTempScopeId,
} from "../src/backend/lineage.js";
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
	input: {
		readonly id: string;
		readonly filenameId?: string;
		readonly parentSession?: string;
		readonly body?: string;
	},
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = path.join(
		root,
		path.dirname(relativePath),
		`2026-08-27T12-00-00-000Z_${input.filenameId ?? input.id}.jsonl`,
	);
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
		it.effect("joins default top-level and sibling nested run roots", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-"});
				const sessionsRoot = path.join(root, "sessions");
				const tempRoot = path.join(root, "pi-subagents");
				const asyncRunsRoot = path.join(tempRoot, "async-subagent-runs");
				const nestedRunsRoot = path.join(tempRoot, "nested-subagent-runs");
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
				yield* writeStatus(asyncRunsRoot, "root-run", {
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
						},
					],
				});
				yield* writeStatus(nestedRunsRoot, "child-run/nested-run", {
					lifecycleArtifactVersion: 3,
					runId: "nested-run",
					sessionId: childFile,
					sessionFile: nestedFile,
					startedAt: 120,
					steps: [{agent: "worker", sessionFile: nestedFile, startedAt: 120, status: "complete"}],
				});

				const options = yield* defaultLineageOptions(
					{
						sessionRoots: [sessionsRoot],
						storePath,
						protocolSessions: [
							{id: "parent", createdAt: 1, cwd: "/tmp/tuval"},
							{id: "child", createdAt: 2, cwd: "/tmp/tuval"},
							{id: "nested", createdAt: 3, parentSessionId: "child", cwd: "/tmp/tuval"},
						],
					},
					{PI_SUBAGENTS_TEMP_ROOT: tempRoot},
					"/home/tuval",
					root,
				);
				assert.deepEqual(options.runRoots, [asyncRunsRoot, nestedRunsRoot]);
				const first = yield* refreshLineage(options);
				const second = yield* refreshLineage({
					...options,
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

		it.effect("owns copied session files by filename instead of stale header ids", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-copied-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {
					id: "stale-parent-header",
					filenameId: "parent",
				});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {
					id: "stale-child-header",
					filenameId: "child",
					parentSession: parentFile,
				});
				yield* writeStatus(runsRoot, "child-run", {
					runId: "wrapper",
					sessionId: parentFile,
					steps: [{runId: "child-run", sessionFile: childFile, startedAt: 100}],
				});

				const projection = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});

				assert.deepEqual(
					projection.graph.nodes.map((node) => node.piSessionId),
					["child", "parent"],
				);
				assert.deepInclude(
					projection.graph.edges.find((edge) => edge.id === "spawn:child-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child")},
				);
				assert.deepInclude(
					projection.graph.edges.find((edge) => edge.kind === "fork"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child"), source: "header"},
				);
				assert.lengthOf(projection.problems, 0);
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
						parent: sessionIdentity("parent"),
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

		it.effect("joins the pi-subagents status run id to its step session file", () =>
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
					startedAt: 100,
					steps: [{agent: "worker", status: "complete", sessionFile: childFile}],
				});
				yield* writeStatus(runsRoot, "revival", {
					runId: "revival-run",
					sessionId: parentFile,
					startedAt: 200,
					steps: [{agent: "worker", status: "complete", sessionFile: childFile}],
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
						parent: sessionIdentity("parent"),
						observedAt: 200,
					},
				]);
			}),
		);

		it.effect("keeps complete runs from multi-step statuses with uid-less sessions", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-multi-step-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const workflowFile = yield* writeSession(sessionsRoot, "workflow.jsonl", {
					id: "workflow",
				});
				const parallelChildFile = yield* writeSession(sessionsRoot, "parallel-child.jsonl", {
					id: "parallel-child",
				});
				const ordinaryA = yield* writeSession(sessionsRoot, "ordinary-a.jsonl", {
					id: "ordinary-a",
				});
				const ordinaryB = yield* writeSession(sessionsRoot, "ordinary-b.jsonl", {
					id: "ordinary-b",
				});
				const ordinarySteps = [
					{agent: "scout", status: "complete", sessionFile: ordinaryA},
					{agent: "reviewer", status: "complete", sessionFile: ordinaryB},
				];
				const parallelChild = {
					runId: "parallel-child-run",
					parentRunId: "workflow-run",
					sessionFile: parallelChildFile,
					startedAt: 210,
				};
				const writeStatuses = (reverse: boolean) =>
					Effect.all(
						[
							writeStatus(runsRoot, "workflow", {
								runId: "workflow-run",
								sessionId: parentFile,
								sessionFile: workflowFile,
								startedAt: 100,
								steps: reverse ? [ordinarySteps[1], ordinarySteps[0]] : ordinarySteps,
								workflow: {
									value: reverse ? "completed output" : ["first output", {ok: true}],
									trace: [],
								},
							}),
							writeStatus(runsRoot, "parallel", {
								runId: "parallel-wrapper",
								sessionId: parentFile,
								startedAt: 200,
								steps: reverse
									? [ordinarySteps[1], parallelChild, ordinarySteps[0]]
									: [ordinarySteps[0], parallelChild, ordinarySteps[1]],
							}),
						],
						{concurrency: "unbounded"},
					);
				yield* writeStatuses(false);

				const first = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				const before = yield* fs.readFileString(storePath);
				yield* writeStatuses(true);
				const reordered = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				const after = yield* fs.readFileString(storePath);

				assert.lengthOf(first.problems, 0);
				assert.deepEqual(
					first.graph.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.id),
					["spawn:parallel-child-run", "spawn:workflow-run"],
				);
				assert.deepInclude(
					first.graph.edges.find((edge) => edge.id === "spawn:workflow-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("workflow")},
				);
				assert.deepInclude(
					first.graph.edges.find((edge) => edge.id === "spawn:parallel-child-run"),
					{parent: sessionIdentity("workflow"), child: sessionIdentity("parallel-child")},
				);
				assert.deepEqual(reordered.graph, first.graph);
				assert.strictEqual(after, before);
			}),
		);

		it.effect("isolates malformed siblings while preserving complete run entries", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-siblings-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const alphaFile = yield* writeSession(sessionsRoot, "alpha.jsonl", {id: "alpha"});
				const betaFile = yield* writeSession(sessionsRoot, "beta.jsonl", {id: "beta"});
				yield* writeStatus(runsRoot, "mixed", {
					runId: "wrapper",
					sessionId: parentFile,
					steps: [
						{runId: "alpha-run", sessionFile: alphaFile, startedAt: 10},
						{},
						{runId: "half-run"},
						{runId: "beta-run", sessionFile: betaFile, startedAt: 20},
					],
					workflow: {
						value: {
							results: [{runId: "invented-run", sessionFile: alphaFile}],
						},
						trace: [],
					},
				});

				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});

				assert.deepEqual(
					projected.graph.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.runId),
					["alpha-run", "beta-run"],
				);
				assert.isUndefined(
					projected.graph.edges.find(
						(edge) => edge.kind === "spawn" && edge.runId === "invented-run",
					),
				);
				assert.lengthOf(projected.problems, 2);
				assert.deepEqual(
					projected.problems.map((problem) => problem.source.split("#")[1]),
					["status.steps[1]", "status.steps[2]"],
				);
			}),
		);

		it.effect("keeps a parentless pre-origin run diagnostic-only", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-pre-origin-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "early", {
					runId: "early-run",
					sessionFile: childFile,
					startedAt: 100,
				});
				yield* writeStatus(runsRoot, "origin", {
					runId: "origin-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 200,
				});

				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});

				assert.deepInclude(
					projected.graph.edges.find((edge) => edge.id === "spawn:origin-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child")},
				);
				assert.isUndefined(projected.graph.continuity.find((value) => value.runId === "early-run"));
				assert.isTrue(
					projected.problems.some((problem) =>
						problem.message.includes("pre-origin run early-run"),
					),
				);
			}),
		);

		it.effect("diagnoses a protocol-only child whose parent is not retained", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-protocol-loss-"});
				const projected = yield* refreshLineage({
					runRoots: [],
					sessionRoots: [],
					storePath: path.join(root, "lineage.json"),
					protocolSessions: [{id: "child", createdAt: 1, parentSessionId: "missing-parent"}],
				});

				assert.lengthOf(projected.graph.nodes, 1);
				assert.lengthOf(projected.graph.edges, 0);
				assert.deepEqual(projected.problems, [
					{
						code: "retention-loss",
						source: "protocol:child",
						message: "Fork parent for child is not retained",
					},
				]);
			}),
		);

		it.effect("keeps an unresolved authoritative parent diagnostic-only", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-parent-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "origin", {
					runId: "origin-run",
					sessionId: parentFile,
					sessionFile: childFile,
					startedAt: 1,
				});
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
				assert.deepEqual(
					projected.graph.edges.filter((edge) => edge.kind === "spawn").map((edge) => edge.runId),
					["origin-run"],
				);
				assert.isUndefined(
					projected.graph.continuity.find((observation) => observation.runId === "child-run"),
				);
				assert.isTrue(
					projected.problems.some((problem) =>
						problem.message.includes("Authoritative parent run missing-run"),
					),
				);
			}),
		);

		it.effect("refuses changed parentage for a persisted continuity run", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-parent-change-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentA = yield* writeSession(sessionsRoot, "parent-a.jsonl", {id: "parent-a"});
				const parentB = yield* writeSession(sessionsRoot, "parent-b.jsonl", {id: "parent-b"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "origin", {
					runId: "origin-run",
					sessionId: parentA,
					sessionFile: childFile,
					startedAt: 1,
				});
				const resumePath = yield* writeStatus(runsRoot, "resume", {
					runId: "resume-run",
					sessionId: parentA,
					sessionFile: childFile,
					startedAt: 2,
				});
				yield* refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath});
				yield* fs.writeFileString(
					resumePath,
					JSON.stringify({
						runId: "resume-run",
						sessionId: parentB,
						sessionFile: childFile,
						startedAt: 2,
					}),
				);

				const changed = yield* Effect.result(
					refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath}),
				);
				assert.isTrue(Result.isFailure(changed));
				if (Result.isFailure(changed)) {
					assert.strictEqual(changed.failure._tag, "tuval/LineageConflictError");
				}
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

		it.effect("diagnoses empty statuses, empty ids, half identities, and malformed entries", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-malformed-"});
				const runsRoot = path.join(root, "runs");
				const sessionsRoot = path.join(root, "sessions");
				yield* writeStatus(runsRoot, "empty", {});
				yield* writeStatus(runsRoot, "empty-run-id", {runId: "", sessionFile: "/tmp/a"});
				yield* writeStatus(runsRoot, "half-run", {runId: "run-only"});
				yield* writeStatus(runsRoot, "half-session", {sessionFile: "/tmp/session-only"});
				yield* writeStatus(runsRoot, "nested", {runId: "wrapper", steps: [{}]});
				yield* writeStatus(runsRoot, "nested-empty-id", {
					runId: "wrapper",
					steps: [{runId: " ", sessionFile: "/tmp/a"}],
				});
				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});
				assert.lengthOf(projected.problems, 6);
				assert.isTrue(projected.problems.every((problem) => problem.code === "malformed-run"));
				assert.lengthOf(projected.graph.edges, 0);
				assert.lengthOf(projected.graph.continuity, 0);
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

		it.effect("refuses duplicate origins and dangling records in a shape-valid durable store", () =>
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
				const parent = {
					...node,
					id: sessionIdentity("parent"),
					piSessionId: "parent",
					sourceFiles: [],
				};
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 1,
						nodes: [parent, node],
						edges: [
							{
								id: "spawn:r1",
								kind: "spawn",
								parent: parent.id,
								child: node.id,
								runId: "r1",
								observedAt: 1,
							},
							{
								id: "spawn:r2",
								kind: "spawn",
								parent: parent.id,
								child: node.id,
								runId: "r2",
								observedAt: 2,
							},
						],
						continuity: [],
					}),
				);
				const duplicateOrigin = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(duplicateOrigin));
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

	it("matches every pi-subagents temp-scope fallback", () => {
		assert.strictEqual(resolvePiSubagentsTempScopeId({env: {}, getuid: () => 42}), "uid-42");
		assert.strictEqual(
			resolvePiSubagentsTempScopeId({
				env: {USERNAME: "Ada Lovelace"},
				getuid: undefined,
				userInfo: undefined,
				homedir: undefined,
			}),
			"user-Ada-Lovelace",
		);
		assert.strictEqual(
			resolvePiSubagentsTempScopeId({
				env: {USERNAME: "", USER: ""},
				getuid: undefined,
				userInfo: () => ({username: "Grace Hopper"}),
				homedir: undefined,
			}),
			"user-Grace-Hopper",
		);
		assert.strictEqual(
			resolvePiSubagentsTempScopeId({
				env: {HOME: "/Users/test person"},
				getuid: undefined,
				userInfo: () => {
					throw new Error("no passwd entry");
				},
				homedir: undefined,
			}),
			"home-Users-test-person",
		);
		assert.strictEqual(
			resolvePiSubagentsTempScopeId({
				env: {},
				getuid: undefined,
				userInfo: () => ({}),
				homedir: () => "/home/fallback user",
			}),
			"home-home-fallback-user",
		);
		assert.strictEqual(
			resolvePiSubagentsTempScopeId({
				env: {},
				getuid: undefined,
				userInfo: undefined,
				homedir: undefined,
			}),
			"shared",
		);
	});

	it("upserts individual edges and continuity idempotently in arbitrary order", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.stringMatching(/^[a-z]{1,8}$/), {maxLength: 30}),
				fc.array(fc.nat({max: 100}), {maxLength: 200}),
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
							parent: parent.id,
							observedAt: index + 100,
						})),
					};
					const seeded = upsertLineageRecords(emptyLineageStore(), {
						nodes: records.nodes,
						edges: [],
						continuity: [],
					});
					if (Result.isFailure(seeded)) return false;
					let graph = seeded.success;
					const observations = [
						...records.edges.map((edge) => ({edges: [edge], continuity: []})),
						...records.continuity.map((observation) => ({edges: [], continuity: [observation]})),
					];
					const permutation = observations
						.map((observation, index) => ({
							observation,
							rank: order[index % Math.max(1, order.length)] ?? index,
							index,
						}))
						.sort((left, right) => left.rank - right.rank || left.index - right.index);
					for (const {observation} of permutation) {
						const next = upsertLineageRecords(graph, {nodes: [], ...observation});
						if (Result.isFailure(next)) return false;
						graph = next.success;
					}
					for (const index of order) {
						const observation = observations[index % Math.max(1, observations.length)];
						if (observation === undefined) continue;
						const repeated = upsertLineageRecords(graph, {nodes: [], ...observation});
						if (Result.isFailure(repeated)) return false;
						graph = repeated.success;
					}
					const expected = upsertLineageRecords(seeded.success, records);
					return (
						Result.isSuccess(expected) && JSON.stringify(graph) === JSON.stringify(expected.success)
					);
				},
			),
		);
	});
});
