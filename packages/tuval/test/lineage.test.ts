import type {SessionMetadata} from "@earendil-works/pi-protocol";
import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Deferred, Effect, Fiber, FileSystem, Path, PlatformError, Result, Schema} from "effect";
import fc from "fast-check";
import {
	defaultLineageOptions,
	LineageStoreReadError,
	loadLineageStore,
	refreshLineage,
	resolvePiSubagentsTempScopeId,
	withLineageStoreFileLock,
	writeLineageStore,
} from "../src/backend/lineage.js";
import {sessionIdentity} from "../src/shared/discovery.js";
import {
	emptyLineageStore,
	LineageProjection,
	type LineageRecords,
	LineageStoreDocument,
	upsertLineageRecords,
	validateLineageStore,
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
		readonly exactPath?: boolean;
	},
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = input.exactPath
		? path.join(root, relativePath)
		: path.join(
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

const availableProtocol = (sessions: ReadonlyArray<SessionMetadata>) =>
	({_tag: "available", sessions}) as const;

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
				const nestedFile = yield* writeSession(
					sessionsRoot,
					"root/run-0/session/nested-child/run-0/session.jsonl",
					{
						id: "nested",
						parentSession: parentFile,
						body: `${"x".repeat(256 * 1024)} not-json {"parentSessionId":"body-parent"}`,
						exactPath: true,
					},
				);
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
						protocolMetadata: availableProtocol([
							{id: "parent", createdAt: 1, cwd: "/tmp/tuval"},
							{id: "child", createdAt: 2, cwd: "/tmp/tuval"},
							{id: "nested", createdAt: 3, parentSessionId: "child", cwd: "/tmp/tuval"},
						]),
					},
					{PI_SUBAGENTS_TEMP_ROOT: tempRoot},
					"/home/tuval",
					root,
				);
				assert.deepEqual(options.runRoots, [asyncRunsRoot, nestedRunsRoot]);
				const first = yield* refreshLineage(options);
				const second = yield* refreshLineage({
					...options,
					protocolMetadata: availableProtocol([
						{id: "parent", createdAt: 1},
						{id: "child", createdAt: 2},
						{id: "nested", createdAt: 3, parentSessionId: "child"},
					]),
				});

				assert.doesNotThrow(() => Schema.decodeUnknownSync(LineageProjection)(first));
				assert.deepEqual(second.graph, first.graph);
				assert.deepEqual(
					first.graph.nodes.map((node) => node.piSessionId),
					["child", "nested", "parent"],
				);
				assert.deepInclude(
					first.graph.nodes.find((node) => node.piSessionId === "nested"),
					{sourceFiles: [nestedFile]},
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

		it.effect("rejects a generic nested session file without a lifecycle owner", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-unowned-"});
				const sessionsRoot = path.join(root, "sessions");
				const sourceFile = yield* writeSession(
					sessionsRoot,
					"owner/run-0/session/child/run-0/session.jsonl",
					{id: "unowned", exactPath: true},
				);

				const projection = yield* refreshLineage({
					runRoots: [],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "lineage.json"),
				});

				assert.lengthOf(projection.graph.nodes, 0);
				assert.deepInclude(
					projection.problems.find((problem) => problem.source === sourceFile),
					{
						code: "malformed-session",
						message: "generic session.jsonl has no matching lifecycle observation",
					},
				);
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

		it.effect("resolves a new child through a retained parent run after source cleanup", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-retained-parent-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const rootFile = yield* writeSession(sessionsRoot, "root.jsonl", {id: "root"});
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const parentStatus = yield* writeStatus(runsRoot, "parent", {
					runId: "parent-run",
					sessionId: rootFile,
					sessionFile: parentFile,
					startedAt: 10,
				});
				yield* refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath});
				yield* fs.remove(path.dirname(parentStatus), {recursive: true});

				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runsRoot, "child", {
					runId: "child-run",
					parentRunId: "parent-run",
					sessionFile: childFile,
					startedAt: 20,
				});
				const extended = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					extended.graph.edges.find((edge) => edge.id === "spawn:child-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child")},
				);
				assert.isFalse(extended.problems.some((problem) => problem.message.includes("parent-run")));

				const bytes = yield* fs.readFileString(storePath);
				yield* fs.remove(runsRoot, {recursive: true});
				yield* fs.remove(sessionsRoot, {recursive: true});
				const restored = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepEqual(restored.graph, extended.graph);
				assert.strictEqual(yield* fs.readFileString(storePath), bytes);
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

		it.effect("keeps protocol failure visible while bounded header fallback remains usable", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-protocol-failure-"});
				const sessionsRoot = path.join(root, "sessions");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				yield* writeSession(sessionsRoot, "child.jsonl", {
					id: "child",
					parentSession: parentFile,
				});
				const failed = yield* refreshLineage({
					runRoots: [],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "failed.json"),
					protocolMetadata: {_tag: "failed", message: "metadata transport unavailable"},
				});
				const absentParent = yield* refreshLineage({
					runRoots: [],
					sessionRoots: [sessionsRoot],
					storePath: path.join(root, "available.json"),
					protocolMetadata: availableProtocol([
						{id: "parent", createdAt: 1},
						{id: "child", createdAt: 2},
					]),
				});

				assert.deepInclude(
					failed.graph.edges.find((edge) => edge.kind === "fork"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child"), source: "header"},
				);
				assert.deepEqual(failed.problems, [
					{
						code: "protocol-unavailable",
						source: "pi-protocol",
						message: "metadata transport unavailable",
					},
				]);
				assert.deepInclude(
					absentParent.graph.edges.find((edge) => edge.kind === "fork"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("child"), source: "header"},
				);
				assert.lengthOf(absentParent.problems, 0);
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
					protocolMetadata: availableProtocol([
						{id: "child", createdAt: 1, parentSessionId: "missing-parent"},
					]),
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

		it.effect("refuses an unresolved parent rewrite of retained parentless continuity", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({
					prefix: "tuval-lineage-parentless-rewrite-",
				});
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
				const resumePath = yield* writeStatus(runsRoot, "resume", {
					runId: "resume-run",
					sessionFile: childFile,
					startedAt: 2,
				});
				const initial = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.isDefined(
					initial.graph.continuity.find(
						(observation) =>
							observation.id === "resume:resume-run" && observation.parent === undefined,
					),
				);

				yield* fs.writeFileString(
					resumePath,
					JSON.stringify({
						runId: "resume-run",
						sessionId: "unknown-parent",
						sessionFile: childFile,
						startedAt: 2,
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

		it.effect("compares unresolved and parentless parent facts before resolution", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				for (const [index, parents] of (
					[
						["unknown-a", "unknown-b"],
						["unknown-a", undefined],
						[undefined, "unknown-a"],
					] as const
				).entries()) {
					const root = yield* fs.makeTempDirectoryScoped({
						prefix: `tuval-lineage-parent-fact-${index}-`,
					});
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
					for (const [name, parent] of ["a", "b"].map(
						(name, parentIndex) => [name, parents[parentIndex]] as const,
					)) {
						yield* writeStatus(runsRoot, `resume-${name}`, {
							runId: "resume-run",
							...(parent === undefined ? {} : {sessionId: parent}),
							sessionFile: childFile,
							startedAt: 2,
						});
					}
					const projected = yield* Effect.result(
						refreshLineage({runRoots: [runsRoot], sessionRoots: [sessionsRoot], storePath}),
					);
					assert.isTrue(Result.isFailure(projected));
					if (Result.isFailure(projected)) {
						assert.strictEqual(projected.failure._tag, "tuval/LineageConflictError");
					}
				}
			}),
		);

		it.effect("keeps identical parentless and unresolved rescans idempotent", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				for (const [index, parent] of [undefined, "unknown-parent"].entries()) {
					const root = yield* fs.makeTempDirectoryScoped({
						prefix: `tuval-lineage-parent-rescan-${index}-`,
					});
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
					yield* writeStatus(runsRoot, "resume", {
						runId: "resume-run",
						...(parent === undefined ? {} : {sessionId: parent}),
						sessionFile: childFile,
						startedAt: 2,
					});
					const first = yield* refreshLineage({
						runRoots: [runsRoot],
						sessionRoots: [sessionsRoot],
						storePath,
					});
					const bytes = yield* fs.readFileString(storePath);
					const second = yield* refreshLineage({
						runRoots: [runsRoot],
						sessionRoots: [sessionsRoot],
						storePath,
					});
					assert.deepEqual(second, first);
					assert.strictEqual(yield* fs.readFileString(storePath), bytes);
					if (parent === undefined) {
						assert.isDefined(
							first.graph.continuity.find((observation) => observation.runId === "resume-run"),
						);
					} else {
						assert.isUndefined(
							first.graph.continuity.find((observation) => observation.runId === "resume-run"),
						);
						assert.isTrue(first.problems.some((problem) => problem.code === "retention-loss"));
					}
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

		it.effect("isolates non-finite source timestamps and keeps the store restartable", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({
					prefix: "tuval-lineage-non-finite-source-",
				});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const statusPath = yield* writeStatus(runsRoot, "infinite", {});
				yield* fs.writeFileString(
					statusPath,
					`{"runId":"infinite-run","sessionId":${JSON.stringify(parentFile)},"sessionFile":${JSON.stringify(childFile)},"startedAt":1e400}`,
				);

				const projected = yield* refreshLineage({
					runRoots: [runsRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.isUndefined(projected.graph.edges.find((edge) => edge.id === "spawn:infinite-run"));
				assert.deepInclude(
					projected.problems.find((problem) => problem.source === statusPath),
					{code: "malformed-run"},
				);
				assert.notInclude(yield* fs.readFileString(storePath), "null");
				assert.deepEqual(yield* loadLineageStore(storePath), projected.graph);
			}),
		);

		it.effect("refuses non-finite protocol timestamps with a typed parse error", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-protocol-time-"});
				const projected = yield* Effect.result(
					refreshLineage({
						runRoots: [],
						sessionRoots: [],
						storePath: path.join(root, "lineage.json"),
						protocolMetadata: availableProtocol([{id: "session", createdAt: Infinity}]),
					}),
				);
				assert.isTrue(Result.isFailure(projected));
				if (Result.isFailure(projected)) {
					assert.strictEqual(projected.failure._tag, "tuval/LineageSourceParseError");
				}
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

		it.effect("refuses a persisted run rewritten to an unresolved session", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-session-rewrite-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const statusPath = yield* writeStatus(runsRoot, "stable", {
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
						sessionFile: path.join(sessionsRoot, "missing.jsonl"),
						startedAt: 10,
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

		it.effect("refuses a persisted run rewritten with an unresolved authoritative parent", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-parent-rewrite-"});
				const sessionsRoot = path.join(root, "sessions");
				const runsRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const statusPath = yield* writeStatus(runsRoot, "stable", {
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
						parentRunId: "missing-parent-run",
						sessionFile: childFile,
						startedAt: 10,
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
					JSON.stringify({
						version: 2,
						nodes: [node, node],
						edges: [],
						continuity: [],
						ownership: [],
					}),
				);
				const duplicate = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(duplicate));
				if (Result.isFailure(duplicate)) {
					assert.strictEqual(duplicate.failure._tag, "tuval/LineageConflictError");
				}
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 2,
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
						ownership: [],
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
						version: 2,
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
						ownership: [
							{
								kind: "observation",
								runId: "r1",
								session: node.id,
								parentReference: {kind: "session", value: "parent"},
								parent: parent.id,
								observedAt: 1,
							},
							{
								kind: "observation",
								runId: "r2",
								session: node.id,
								parentReference: {kind: "session", value: "parent"},
								parent: parent.id,
								observedAt: 2,
							},
						],
					}),
				);
				const duplicateOrigin = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(duplicateOrigin));
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 2,
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
						ownership: [
							{
								kind: "observation",
								runId: "r",
								session: node.id,
								parentReference: {kind: "session", value: "missing"},
								parent: sessionIdentity("missing"),
								observedAt: 1,
							},
						],
					}),
				);
				const dangling = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(dangling));
			}),
		);

		it.effect("refuses non-finite timestamps in durable stores on decode", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-store-time-"});
				const storePath = path.join(root, "lineage.json");
				const node = {
					id: sessionIdentity("child"),
					piSessionId: "child",
					createdAt: 1,
					updatedAt: 2,
					cwd: "/tmp",
					sourceFiles: [],
				};
				const parent = {
					...node,
					id: sessionIdentity("parent"),
					piSessionId: "parent",
				};
				const withLiteral = (document: unknown, literal: "1e400" | "-1e400") =>
					JSON.stringify(document).replace('"NON_FINITE"', literal);
				const documents = [
					withLiteral(
						{
							version: 2,
							nodes: [{...node, createdAt: "NON_FINITE"}],
							edges: [],
							continuity: [],
							ownership: [],
						},
						"1e400",
					),
					withLiteral(
						{
							version: 2,
							nodes: [{...node, updatedAt: "NON_FINITE"}],
							edges: [],
							continuity: [],
							ownership: [],
						},
						"-1e400",
					),
					withLiteral(
						{
							version: 2,
							nodes: [parent, node],
							edges: [
								{
									id: "spawn:run",
									kind: "spawn",
									parent: parent.id,
									child: node.id,
									runId: "run",
									observedAt: "NON_FINITE",
								},
							],
							continuity: [],
							ownership: [
								{
									kind: "observation",
									runId: "run",
									session: node.id,
									parentReference: {kind: "session", value: "parent"},
									parent: parent.id,
									observedAt: "NON_FINITE",
								},
							],
						},
						"1e400",
					),
					withLiteral(
						{
							version: 2,
							nodes: [parent, node],
							edges: [],
							continuity: [
								{
									id: "resume:run",
									runId: "run",
									session: node.id,
									parent: parent.id,
									observedAt: "NON_FINITE",
								},
							],
							ownership: [
								{
									kind: "observation",
									runId: "run",
									session: node.id,
									parentReference: {kind: "session", value: "parent"},
									parent: parent.id,
									observedAt: "NON_FINITE",
								},
							],
						},
						"-1e400",
					),
				];
				for (const document of documents) {
					yield* fs.writeFileString(storePath, document);
					const loaded = yield* Effect.result(loadLineageStore(storePath));
					assert.isTrue(Result.isFailure(loaded));
					if (Result.isFailure(loaded)) {
						assert.strictEqual(loaded.failure._tag, "tuval/LineageStoreReadError");
					}
				}
			}),
		);

		it.effect("retains direct ownership when its authoritative parent is unresolved", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-direct-retained-"});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const firstFile = yield* writeSession(sessionsRoot, "first.jsonl", {id: "first"});
				const laterFile = yield* writeSession(sessionsRoot, "later.jsonl", {id: "later"});
				yield* writeStatus(runRoot, "parent", {
					runId: "retained-parent-run",
					parentRunId: "missing-authoritative-parent",
					sessionFile: parentFile,
					startedAt: 1,
				});
				yield* writeStatus(runRoot, "first", {
					runId: "first-run",
					parentRunId: "retained-parent-run",
					sessionFile: firstFile,
					startedAt: 2,
				});
				const first = yield* refreshLineage({
					runRoots: [runRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					first.graph.ownership.find((entry) => entry.runId === "retained-parent-run"),
					{runId: "retained-parent-run", session: sessionIdentity("parent")},
				);
				yield* fs.remove(runRoot, {recursive: true});
				yield* writeStatus(runRoot, "later", {
					runId: "later-run",
					parentRunId: "retained-parent-run",
					sessionFile: laterFile,
					startedAt: 3,
				});
				const restored = yield* refreshLineage({
					runRoots: [runRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					restored.graph.edges.find((edge) => edge.id === "spawn:later-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("later")},
				);
			}),
		);

		it.effect("retains unresolved direct parent facts across restart", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({
					prefix: "tuval-lineage-direct-parent-fact-",
				});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const writeChild = (parentRunId?: string) =>
					writeStatus(runRoot, "child", {
						runId: "child-run",
						...(parentRunId === undefined ? {} : {parentRunId}),
						sessionFile: child,
						startedAt: 1,
					});

				yield* writeChild("missing-a");
				const first = yield* refreshLineage({
					runRoots: [runRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					first.graph.ownership.find((entry) => entry.runId === "child-run"),
					{kind: "direct", parentReference: {kind: "run", value: "missing-a"}},
				);
				yield* fs.remove(runRoot, {recursive: true});
				yield* writeChild("missing-a");
				yield* refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath});

				for (const parentRunId of ["missing-b", undefined]) {
					yield* fs.remove(runRoot, {recursive: true});
					yield* writeChild(parentRunId);
					const changed = yield* Effect.result(
						refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath}),
					);
					assert.isTrue(Result.isFailure(changed));
					if (Result.isFailure(changed)) {
						assert.strictEqual(changed.failure._tag, "tuval/LineageConflictError");
					}
				}
			}),
		);

		it.effect("refuses a wrapper that conflicts with a transient direct ownership", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({
					prefix: "tuval-lineage-transient-conflict-",
				});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const parentA = yield* writeSession(sessionsRoot, "parent-a.jsonl", {id: "parent-a"});
				const parentB = yield* writeSession(sessionsRoot, "parent-b.jsonl", {id: "parent-b"});
				const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runRoot, "direct", {
					runId: "shared-run",
					parentRunId: "missing-parent",
					sessionFile: parentA,
					startedAt: 1,
				});
				yield* writeStatus(runRoot, "wrapper", {
					runId: "shared-run",
					sessionId: parentB,
					steps: [{runId: "child-run", sessionFile: child, startedAt: 2}],
				});
				const result = yield* Effect.result(
					refreshLineage({
						runRoots: [runRoot],
						sessionRoots: [sessionsRoot],
						storePath: path.join(root, "lineage.json"),
					}),
				);
				assert.isTrue(Result.isFailure(result));
				if (Result.isFailure(result)) {
					assert.strictEqual(result.failure._tag, "tuval/LineageConflictError");
				}
			}),
		);

		it.effect("retains wrapper ownership after source deletion", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-wrapper-retained-"});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parentFile = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const childFile = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const descendantFile = yield* writeSession(sessionsRoot, "descendant.jsonl", {
					id: "descendant",
				});
				yield* writeStatus(runRoot, "wrapper", {
					runId: "wrapper-run",
					sessionId: parentFile,
					steps: [{runId: "child-run", sessionFile: childFile, startedAt: 10}],
				});
				yield* refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath});
				yield* fs.remove(runRoot, {recursive: true});
				yield* writeStatus(runRoot, "descendant", {
					runId: "descendant-run",
					parentRunId: "wrapper-run",
					sessionFile: descendantFile,
					startedAt: 20,
				});
				const projection = yield* refreshLineage({
					runRoots: [runRoot],
					sessionRoots: [sessionsRoot],
					storePath,
				});
				assert.deepInclude(
					projection.graph.edges.find((edge) => edge.id === "spawn:descendant-run"),
					{parent: sessionIdentity("parent"), child: sessionIdentity("descendant")},
				);
				assert.notInclude(
					projection.problems.map((problem) => problem.code),
					"retention-loss",
				);
				assert.deepInclude(
					projection.graph.ownership.find((ownership) => ownership.runId === "wrapper-run"),
					{runId: "wrapper-run", session: sessionIdentity("parent")},
				);
			}),
		);

		it.effect("refuses wrapper ownership conflicts across every ownership source", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-wrapper-conflict-"});
				const sessionsRoot = path.join(root, "sessions");
				const parentA = yield* writeSession(sessionsRoot, "parent-a.jsonl", {id: "parent-a"});
				const parentB = yield* writeSession(sessionsRoot, "parent-b.jsonl", {id: "parent-b"});
				const childA = yield* writeSession(sessionsRoot, "child-a.jsonl", {id: "child-a"});
				const childB = yield* writeSession(sessionsRoot, "child-b.jsonl", {id: "child-b"});
				for (const reverse of [false, true]) {
					const runRoot = path.join(root, reverse ? "reverse" : "forward");
					const statuses = [
						{
							runId: "shared-wrapper",
							sessionId: parentA,
							steps: [{runId: "a", sessionFile: childA, startedAt: 1}],
						},
						{
							runId: "shared-wrapper",
							sessionId: parentB,
							steps: [{runId: "b", sessionFile: childB, startedAt: 2}],
						},
					];
					for (const [index, status] of (reverse ? statuses.reverse() : statuses).entries()) {
						yield* writeStatus(runRoot, `status-${index}`, status);
					}
					const result = yield* Effect.result(
						refreshLineage({
							runRoots: [runRoot],
							sessionRoots: [sessionsRoot],
							storePath: path.join(root, `store-${reverse}.json`),
						}),
					);
					assert.isTrue(Result.isFailure(result));
					if (Result.isFailure(result))
						assert.strictEqual(result.failure._tag, "tuval/LineageConflictError");
				}
			}),
		);

		it.effect("refuses wrapper ownership conflicts with direct and retained mappings", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-wrapper-direct-"});
				const sessionsRoot = path.join(root, "sessions");
				const parentA = yield* writeSession(sessionsRoot, "parent-a.jsonl", {id: "parent-a"});
				const parentB = yield* writeSession(sessionsRoot, "parent-b.jsonl", {id: "parent-b"});
				const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				const sameScanRoot = path.join(root, "same-scan");
				yield* writeStatus(sameScanRoot, "direct", {
					runId: "shared",
					sessionFile: parentA,
					startedAt: 1,
				});
				yield* writeStatus(sameScanRoot, "wrapper", {
					runId: "shared",
					sessionId: parentB,
					steps: [{runId: "child", sessionFile: child, startedAt: 2}],
				});
				const sameScan = yield* Effect.result(
					refreshLineage({
						runRoots: [sameScanRoot],
						sessionRoots: [sessionsRoot],
						storePath: path.join(root, "same-scan.json"),
					}),
				);
				assert.isTrue(Result.isFailure(sameScan));

				const retainedRoot = path.join(root, "retained");
				const retainedStore = path.join(root, "retained.json");
				yield* writeStatus(retainedRoot, "direct", {
					runId: "retained-shared",
					sessionFile: parentA,
					startedAt: 1,
				});
				yield* refreshLineage({
					runRoots: [retainedRoot],
					sessionRoots: [sessionsRoot],
					storePath: retainedStore,
				});
				yield* fs.remove(retainedRoot, {recursive: true});
				yield* writeStatus(retainedRoot, "wrapper", {
					runId: "retained-shared",
					sessionId: parentB,
					steps: [{runId: "later-child", sessionFile: child, startedAt: 2}],
				});
				const retained = yield* Effect.result(
					refreshLineage({
						runRoots: [retainedRoot],
						sessionRoots: [sessionsRoot],
						storePath: retainedStore,
					}),
				);
				assert.isTrue(Result.isFailure(retained));
			}),
		);

		it.effect("does not let an unresolved duplicate run borrow a sibling session", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({
					prefix: "tuval-lineage-unresolved-sibling-",
				});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runRoot, "resolved", {
					runId: "shared",
					sessionFile: child,
					startedAt: 1,
				});
				yield* writeStatus(runRoot, "missing", {
					runId: "shared",
					sessionFile: path.join(root, "missing.jsonl"),
					startedAt: 1,
				});
				const result = yield* Effect.result(
					refreshLineage({
						runRoots: [runRoot],
						sessionRoots: [sessionsRoot],
						storePath: path.join(root, "lineage.json"),
					}),
				);
				assert.isTrue(Result.isFailure(result));
				if (Result.isFailure(result))
					assert.strictEqual(result.failure._tag, "tuval/LineageConflictError");
			}),
		);

		it.effect("retains authoritative parent reference identity across restart", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-parent-reference-"});
				const sessionsRoot = path.join(root, "sessions");
				const runRoot = path.join(root, "runs");
				const storePath = path.join(root, "lineage.json");
				const parent = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
				const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
				yield* writeStatus(runRoot, "parent", {
					runId: "parent-run",
					sessionFile: parent,
					startedAt: 1,
				});
				yield* writeStatus(runRoot, "child", {
					runId: "child-run",
					parentRunId: "parent-run",
					sessionFile: child,
					startedAt: 2,
				});
				yield* refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath});
				yield* fs.remove(runRoot, {recursive: true});
				yield* writeStatus(runRoot, "child", {
					runId: "child-run",
					sessionId: parent,
					sessionFile: child,
					startedAt: 2,
				});
				const changed = yield* Effect.result(
					refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath}),
				);
				assert.isTrue(Result.isFailure(changed));
				if (Result.isFailure(changed))
					assert.strictEqual(changed.failure._tag, "tuval/LineageConflictError");
			}),
		);

		it.effect(
			"refuses changed parent-run identity after restart even when both resolve alike",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const root = yield* fs.makeTempDirectoryScoped({
						prefix: "tuval-lineage-parent-run-rewrite-",
					});
					const sessionsRoot = path.join(root, "sessions");
					const runRoot = path.join(root, "runs");
					const storePath = path.join(root, "lineage.json");
					const parent = yield* writeSession(sessionsRoot, "parent.jsonl", {id: "parent"});
					const child = yield* writeSession(sessionsRoot, "child.jsonl", {id: "child"});
					for (const runId of ["parent-a", "parent-b"]) {
						yield* writeStatus(runRoot, runId, {runId, sessionFile: parent, startedAt: 1});
					}
					yield* writeStatus(runRoot, "child", {
						runId: "child-run",
						parentRunId: "parent-a",
						sessionFile: child,
						startedAt: 2,
					});
					yield* refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath});
					yield* fs.remove(path.join(runRoot, "child"), {recursive: true});
					yield* writeStatus(runRoot, "child", {
						runId: "child-run",
						parentRunId: "parent-b",
						sessionFile: child,
						startedAt: 2,
					});
					const changed = yield* Effect.result(
						refreshLineage({runRoots: [runRoot], sessionRoots: [sessionsRoot], storePath}),
					);
					assert.isTrue(Result.isFailure(changed));
				}),
		);

		it.effect("refuses missing and mismatched run-valued parent ownership", () =>
			Effect.sync(() => {
				const parent = {
					id: sessionIdentity("parent"),
					piSessionId: "parent",
					createdAt: 1,
					updatedAt: 1,
					cwd: "/tmp",
					sourceFiles: [],
				};
				const other = {...parent, id: sessionIdentity("other"), piSessionId: "other"};
				const child = {...parent, id: sessionIdentity("child"), piSessionId: "child"};
				const childOwnership = {
					kind: "observation" as const,
					runId: "child-run",
					session: child.id,
					parentReference: {kind: "run" as const, value: "parent-run"},
					parent: parent.id,
					observedAt: 2,
				};
				const missing = validateLineageStore({
					version: 2,
					nodes: [parent, child],
					edges: [],
					continuity: [],
					ownership: [childOwnership],
				});
				assert.isTrue(Result.isFailure(missing));
				const mismatched = validateLineageStore({
					version: 2,
					nodes: [parent, other, child],
					edges: [],
					continuity: [],
					ownership: [{kind: "wrapper", runId: "parent-run", session: other.id}, childOwnership],
				});
				assert.isTrue(Result.isFailure(mismatched));
			}),
		);

		it.effect("canonicalizes durable order and rejects the pre-round-11 store version", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-canonical-store-"});
				const storePath = path.join(root, "lineage.json");
				const node = (id: string, sources: ReadonlyArray<string>) => ({
					id: sessionIdentity(id),
					piSessionId: id,
					createdAt: 1,
					updatedAt: 1,
					cwd: "/tmp",
					sourceFiles: sources,
				});
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 1,
						nodes: [node("b", ["/z", "/y"]), node("a", ["/x"])],
						edges: [],
						continuity: [],
					}),
				);
				const oldVersion = yield* Effect.result(loadLineageStore(storePath));
				assert.isTrue(Result.isFailure(oldVersion));
				if (Result.isFailure(oldVersion)) {
					assert.strictEqual(oldVersion.failure._tag, "tuval/LineageStoreVersionError");
				}
				yield* fs.writeFileString(
					storePath,
					JSON.stringify({
						version: 2,
						nodes: [node("b", ["/z", "/y"]), node("a", ["/x"])],
						edges: [],
						continuity: [],
						ownership: [],
					}),
				);
				const canonical = yield* loadLineageStore(storePath);
				assert.deepEqual(
					canonical.nodes.map((entry) => entry.piSessionId),
					["a", "b"],
				);
				assert.deepEqual(canonical.nodes[1]?.sourceFiles, ["/y", "/z"]);
				const missing = path.join(root, "missing");
				yield* refreshLineage({runRoots: [missing], sessionRoots: [missing], storePath});
				const firstBytes = yield* fs.readFileString(storePath);
				yield* refreshLineage({runRoots: [missing], sessionRoots: [missing], storePath});
				assert.strictEqual(yield* fs.readFileString(storePath), firstBytes);
			}),
		);

		it.effect("publishes owner metadata atomically before the lock becomes visible", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-lock-publish-"});
				const storePath = path.join(root, "lineage.json");
				const lockPath = `${storePath}.lock`;
				const publicationPaused = yield* Deferred.make<void>();
				const resumePublication = yield* Deferred.make<void>();
				let pauseFirst = true;
				const delayedPublication = FileSystem.FileSystem.of({
					...fs,
					rename: (from, to) =>
						pauseFirst && from.includes(".preparing-") && to === lockPath
							? Effect.sync(() => {
									pauseFirst = false;
								}).pipe(
									Effect.andThen(Deferred.succeed(publicationPaused, undefined)),
									Effect.andThen(Deferred.await(resumePublication)),
									Effect.andThen(fs.rename(from, to)),
								)
							: fs.rename(from, to),
				});
				const order: Array<string> = [];
				const first = yield* withLineageStoreFileLock(
					storePath,
					() => Effect.sync(() => order.push("first")),
					{poll: Effect.yieldNow},
				).pipe(Effect.provideService(FileSystem.FileSystem, delayedPublication), Effect.forkChild);
				yield* Deferred.await(publicationPaused);
				assert.isFalse(yield* fs.exists(lockPath));
				yield* withLineageStoreFileLock(storePath, () => Effect.sync(() => order.push("second")), {
					poll: Effect.yieldNow,
				});
				yield* Deferred.succeed(resumePublication, undefined);
				yield* Fiber.join(first);
				assert.deepEqual(order, ["second", "first"]);
				assert.isFalse(yield* fs.exists(lockPath));
			}),
		);

		it.effect("does not steal a live owner refreshed after stale observation", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectory({prefix: "tuval-lineage-lock-heartbeat-"});
				const storePath = path.join(root, "lineage.json");
				const lockPath = `${storePath}.lock`;
				const ownerPath = path.join(lockPath, "owner");
				const enteredOld = yield* Deferred.make<void>();
				const releaseOld = yield* Deferred.make<void>();
				const enteredNew = yield* Deferred.make<void>();
				const staleObserved = yield* Deferred.make<void>();
				const ownerRestored = yield* Deferred.make<void>();
				const old = yield* withLineageStoreFileLock(
					storePath,
					() =>
						Deferred.succeed(enteredOld, undefined).pipe(
							Effect.andThen(Deferred.await(releaseOld)),
						),
					{poll: Effect.yieldNow, staleMs: 60_000, disableHeartbeat: true},
				).pipe(Effect.forkChild);
				yield* Deferred.await(enteredOld);
				const stale = new Date(Date.now() - 600_000);
				yield* fs.utimes(ownerPath, stale, stale);
				const successor = yield* withLineageStoreFileLock(
					storePath,
					() => Deferred.succeed(enteredNew, undefined),
					{
						poll: Effect.yieldNow,
						staleMs: 60_000,
						disableHeartbeat: true,
						onStaleObserved: fs
							.utimes(ownerPath, new Date(), new Date())
							.pipe(Effect.orDie, Effect.andThen(Deferred.succeed(staleObserved, undefined))),
						onLiveOwnerRestored: Deferred.succeed(ownerRestored, undefined).pipe(
							Effect.andThen(Effect.interrupt),
						),
					},
				).pipe(Effect.forkChild);
				yield* Deferred.await(staleObserved);
				yield* Deferred.await(ownerRestored);
				const enteredTooEarly = yield* Deferred.poll(enteredNew);
				assert.strictEqual(enteredTooEarly._tag, "None");
				yield* Fiber.await(successor);
				yield* Deferred.succeed(releaseOld, undefined);
				yield* Fiber.join(old);
				assert.isFalse(yield* fs.exists(lockPath));
				yield* fs.remove(root, {recursive: true});
			}),
		);

		it.effect("serializes independent callers and competing stale-lock recovery", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-file-lock-"});
				const storePath = path.join(root, "lineage.json");
				let active = 0;
				let maximum = 0;
				const caller = withLineageStoreFileLock(
					storePath,
					() =>
						Effect.gen(function* () {
							active += 1;
							maximum = Math.max(maximum, active);
							yield* Effect.yieldNow;
							active -= 1;
						}),
					{poll: Effect.yieldNow},
				);
				yield* Effect.all([caller, caller], {concurrency: "unbounded"});
				assert.strictEqual(maximum, 1);
				const lockPath = `${storePath}.lock`;
				const ownerPath = path.join(lockPath, "owner");
				const orphanedGeneration = `${lockPath}.generation-orphan`;
				yield* fs.makeDirectory(orphanedGeneration);
				const stale = new Date(Date.now() - 10 * 60 * 1_000);
				yield* fs.utimes(orphanedGeneration, stale, stale);
				yield* caller;
				assert.isFalse(yield* fs.exists(orphanedGeneration));
				yield* fs.makeDirectory(lockPath);
				yield* fs.writeFileString(ownerPath, "dead-owner");
				yield* fs.utimes(ownerPath, stale, stale);
				maximum = 0;
				yield* Effect.all([caller, caller], {concurrency: "unbounded"});
				assert.strictEqual(maximum, 1);
				assert.isFalse(yield* fs.exists(lockPath));
			}),
		);

		it.effect("fences a resumed predecessor and preserves the successor generation", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-lock-generation-"});
				const storePath = path.join(root, "lineage.json");
				const lockPath = `${storePath}.lock`;
				const ownerPath = path.join(lockPath, "owner");
				const enteredOld = yield* Deferred.make<void>();
				const releaseOld = yield* Deferred.make<void>();
				const enteredNew = yield* Deferred.make<void>();
				const releaseNew = yield* Deferred.make<void>();
				let predecessorCommitted = false;
				const oldFiber = yield* withLineageStoreFileLock(
					storePath,
					(fence) =>
						Deferred.succeed(enteredOld, undefined).pipe(
							Effect.andThen(Deferred.await(releaseOld)),
							Effect.andThen(fence),
							Effect.andThen(Effect.sync(() => (predecessorCommitted = true))),
						),
					{poll: Effect.yieldNow, staleMs: 1, disableHeartbeat: true},
				).pipe(Effect.result, Effect.forkChild);
				yield* Deferred.await(enteredOld);
				const stale = new Date(Date.now() - 1_000);
				yield* fs.utimes(ownerPath, stale, stale);
				const newFiber = yield* withLineageStoreFileLock(
					storePath,
					() =>
						Deferred.succeed(enteredNew, undefined).pipe(
							Effect.andThen(Deferred.await(releaseNew)),
						),
					{poll: Effect.yieldNow, staleMs: 1},
				).pipe(Effect.forkChild);
				yield* Deferred.await(enteredNew);
				yield* Deferred.succeed(releaseOld, undefined);
				const oldResult = yield* Fiber.join(oldFiber);
				assert.isTrue(Result.isFailure(oldResult));
				assert.isFalse(predecessorCommitted);
				assert.isTrue(yield* fs.exists(lockPath));
				yield* Deferred.succeed(releaseNew, undefined);
				yield* Fiber.join(newFiber);
				assert.isFalse(yield* fs.exists(lockPath));
			}),
		);

		it.effect("cleans temporary files after write and rename failures", () =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped({prefix: "tuval-lineage-write-cleanup-"});
				const storePath = path.join(root, "lineage.json");
				yield* fs.writeFileString(storePath, "stable\n");
				const failure = (method: "writeFileString" | "rename", target: string) =>
					PlatformError.systemError({
						_tag: "PermissionDenied",
						module: "FileSystem",
						method,
						pathOrDescriptor: target,
					});
				const partialWrite = FileSystem.FileSystem.of({
					...fs,
					writeFileString: (target, text, options) =>
						target.endsWith(".tmp")
							? fs
									.writeFileString(target, "partial", options)
									.pipe(Effect.andThen(Effect.fail(failure("writeFileString", target))))
							: fs.writeFileString(target, text, options),
				});
				const writeFailure = yield* Effect.result(
					writeLineageStore(storePath, emptyLineageStore()).pipe(
						Effect.provideService(FileSystem.FileSystem, partialWrite),
					),
				);
				assert.isTrue(Result.isFailure(writeFailure));
				assert.deepEqual(yield* fs.readDirectory(root), ["lineage.json"]);
				assert.strictEqual(yield* fs.readFileString(storePath), "stable\n");
				const failedRename = FileSystem.FileSystem.of({
					...fs,
					rename: (from, to) => Effect.fail(failure("rename", `${from}->${to}`)),
				});
				const renameFailure = yield* Effect.result(
					writeLineageStore(storePath, emptyLineageStore()).pipe(
						Effect.provideService(FileSystem.FileSystem, failedRename),
					),
				);
				assert.isTrue(Result.isFailure(renameFailure));
				assert.deepEqual(yield* fs.readDirectory(root), ["lineage.json"]);
				assert.strictEqual(yield* fs.readFileString(storePath), "stable\n");
				const fenced = yield* Effect.result(
					writeLineageStore(
						storePath,
						emptyLineageStore(),
						Effect.fail(
							new LineageStoreReadError({
								path: `${storePath}.lock`,
								message: "ownership changed",
							}),
						),
					),
				);
				assert.isTrue(Result.isFailure(fenced));
				assert.deepEqual(yield* fs.readDirectory(root), ["lineage.json"]);
				assert.strictEqual(yield* fs.readFileString(storePath), "stable\n");
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

	it("rejects non-finite timestamps at the schema encode boundary", () => {
		const node = {
			id: sessionIdentity("encode-node"),
			piSessionId: "encode-node",
			createdAt: Number.POSITIVE_INFINITY,
			updatedAt: 1,
			cwd: "/tmp/tuval",
			sourceFiles: [],
		};
		assert.throws(() =>
			Schema.encodeSync(LineageStoreDocument)({
				version: 2,
				nodes: [node],
				edges: [],
				continuity: [],
				ownership: [],
			}),
		);
	});

	it("rejects every non-finite timestamp at the domain boundary", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
				fc.constantFrom("createdAt", "updatedAt", "spawn", "continuity"),
				(value, location) => {
					const parent = {
						id: sessionIdentity("finite-parent"),
						piSessionId: "finite-parent",
						createdAt: location === "createdAt" ? value : 1,
						updatedAt: location === "updatedAt" ? value : 1,
						cwd: "/tmp/tuval",
						sourceFiles: [],
					};
					const child = {
						...parent,
						id: sessionIdentity("finite-child"),
						piSessionId: "finite-child",
						createdAt: 1,
						updatedAt: 1,
					};
					const result = upsertLineageRecords(emptyLineageStore(), {
						nodes: [parent, child],
						edges:
							location === "spawn"
								? [
										{
											id: "spawn:run",
											kind: "spawn" as const,
											parent: parent.id,
											child: child.id,
											runId: "run",
											observedAt: value,
										},
									]
								: [],
						continuity:
							location === "continuity"
								? [
										{
											id: "resume:run",
											runId: "run",
											session: child.id,
											parent: parent.id,
											observedAt: value,
										},
									]
								: [],
					});
					return Result.isFailure(result);
				},
			),
		);
	});

	it("rejects non-finite incoming timestamps before merge masking", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
				fc.constantFrom("createdAt", "updatedAt"),
				(value, field) => {
					const retained = {
						id: sessionIdentity("masked-node"),
						piSessionId: "masked-node",
						createdAt: 1,
						updatedAt: 2,
						cwd: "/tmp",
						sourceFiles: [],
					};
					const current = upsertLineageRecords(emptyLineageStore(), {
						nodes: [retained],
						edges: [],
						continuity: [],
					});
					if (Result.isFailure(current)) return false;
					return Result.isFailure(
						upsertLineageRecords(current.success, {
							nodes: [{...retained, [field]: value}],
							edges: [],
							continuity: [],
						}),
					);
				},
			),
		);
	});

	it("rejects cycles, orphan continuity, and backward node intervals", () => {
		const node = (id: string, createdAt = 1, updatedAt = 1) => ({
			id: sessionIdentity(id),
			piSessionId: id,
			createdAt,
			updatedAt,
			cwd: "/tmp",
			sourceFiles: [],
		});
		const backward = validateLineageStore({
			version: 2,
			nodes: [node("backward", 2, 1)],
			edges: [],
			continuity: [],
			ownership: [],
		});
		assert.isTrue(Result.isFailure(backward));
		const cyclic = validateLineageStore({
			version: 2,
			nodes: [node("a"), node("b")],
			edges: [
				{
					id: `fork:${sessionIdentity("b")}`,
					kind: "fork",
					parent: sessionIdentity("a"),
					child: sessionIdentity("b"),
					source: "protocol",
				},
				{
					id: `fork:${sessionIdentity("a")}`,
					kind: "fork",
					parent: sessionIdentity("b"),
					child: sessionIdentity("a"),
					source: "protocol",
				},
			],
			continuity: [],
			ownership: [],
		});
		assert.isTrue(Result.isFailure(cyclic));
		const orphan = validateLineageStore({
			version: 2,
			nodes: [node("orphan")],
			edges: [],
			continuity: [{id: "resume:r", runId: "r", session: sessionIdentity("orphan"), observedAt: 2}],
			ownership: [
				{
					kind: "observation",
					runId: "r",
					session: sessionIdentity("orphan"),
					parentReference: {kind: "none"},
					observedAt: 2,
				},
			],
		});
		assert.isTrue(Result.isFailure(orphan));
	});

	it("rejects same-run and equal-time pre-origin continuity", () => {
		const node = (id: string) => ({
			id: sessionIdentity(id),
			piSessionId: id,
			createdAt: 1,
			updatedAt: 1,
			cwd: "/tmp",
			sourceFiles: [],
		});
		const parent = node("chronology-parent");
		const child = node("chronology-child");
		const origin = {
			kind: "observation" as const,
			runId: "z-origin",
			session: child.id,
			parentReference: {kind: "session" as const, value: "chronology-parent"},
			parent: parent.id,
			observedAt: 10,
		};
		const graph = {
			version: 2 as const,
			nodes: [parent, child],
			edges: [
				{
					id: "spawn:z-origin",
					kind: "spawn" as const,
					parent: parent.id,
					child: child.id,
					runId: "z-origin",
					observedAt: 10,
				},
			],
			ownership: [origin],
		};
		const sameRun = validateLineageStore({
			...graph,
			continuity: [
				{
					id: "resume:z-origin",
					runId: "z-origin",
					session: child.id,
					parent: parent.id,
					observedAt: 11,
				},
			],
		});
		assert.isTrue(Result.isFailure(sameRun));
		const preOrigin = validateLineageStore({
			...graph,
			continuity: [
				{
					id: "resume:a-resume",
					runId: "a-resume",
					session: child.id,
					parent: parent.id,
					observedAt: 10,
				},
			],
			ownership: [
				origin,
				{
					kind: "observation" as const,
					runId: "a-resume",
					session: child.id,
					parentReference: {kind: "session" as const, value: "chronology-parent"},
					parent: parent.id,
					observedAt: 10,
				},
			],
		});
		assert.isTrue(Result.isFailure(preOrigin));
	});

	it("canonical ordering is total for locale-equivalent distinct strings", () => {
		const values = ["é", "e\u0301", "I", "ı"];
		fc.assert(
			fc.property(
				fc.shuffledSubarray(values, {minLength: values.length, maxLength: values.length}),
				(order) => {
					const nodes = order.map((id) => ({
						id: sessionIdentity(id),
						piSessionId: id,
						createdAt: 1,
						updatedAt: 1,
						cwd: id,
						sourceFiles: [`/${id}`],
					}));
					const validated = validateLineageStore({
						version: 2,
						nodes,
						edges: [],
						continuity: [],
						ownership: [],
					});
					if (Result.isFailure(validated)) return false;
					return (
						JSON.stringify(validated.success) ===
						JSON.stringify(
							validateLineageStore({
								version: 2,
								nodes: [...nodes].reverse(),
								edges: [],
								continuity: [],
								ownership: [],
							}).pipe(Result.getOrThrow),
						)
					);
				},
			),
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
					const edges = children.map((node, index) => ({
						id: `spawn:${runIds[index] as string}`,
						kind: "spawn" as const,
						parent: parent.id,
						child: node.id,
						runId: runIds[index] as string,
						observedAt: index,
					}));
					const continuity = children.map((node, index) => ({
						id: `resume:resume-${runIds[index] as string}`,
						runId: `resume-${runIds[index] as string}`,
						session: node.id,
						parent: parent.id,
						observedAt: index + 100,
					}));
					const records: LineageRecords = {
						nodes: [parent, ...children],
						edges,
						continuity,
						ownership: [
							...edges.map((edge) => ({
								kind: "observation" as const,
								runId: edge.runId,
								session: edge.child,
								parentReference: {kind: "session" as const, value: parent.piSessionId},
								parent: parent.id,
								observedAt: edge.observedAt,
							})),
							...continuity.map((observation) => ({
								kind: "observation" as const,
								runId: observation.runId,
								session: observation.session,
								parentReference: {kind: "session" as const, value: parent.piSessionId},
								parent: parent.id,
								observedAt: observation.observedAt,
							})),
						],
					};
					const seeded = upsertLineageRecords(emptyLineageStore(), {
						nodes: records.nodes,
						edges: [],
						continuity: [],
					});
					if (Result.isFailure(seeded)) return false;
					let graph = seeded.success;
					const spawnObservations = edges.map((edge) => ({
						edges: [edge],
						continuity: [],
						ownership: records.ownership?.filter((owner) => owner.runId === edge.runId) ?? [],
					}));
					const continuityObservations = continuity.map((observation) => ({
						edges: [],
						continuity: [observation],
						ownership:
							records.ownership?.filter((owner) => owner.runId === observation.runId) ?? [],
					}));
					const permute = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> =>
						values
							.map((observation, index) => ({
								observation,
								rank: order[index % Math.max(1, order.length)] ?? index,
								index,
							}))
							.sort((left, right) => left.rank - right.rank || left.index - right.index)
							.map(({observation}) => observation);
					const observations = [...permute(spawnObservations), ...permute(continuityObservations)];
					for (const observation of observations) {
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
