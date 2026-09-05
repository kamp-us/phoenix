/**
 * The `pi-session` row as a config module hands it over: what it declares, that the registry
 * spawns it, that a fresh session's cwd is the project root the kernel booted from, and that the
 * per-launch capability token is nowhere near the checkpoint.
 *
 * The layer under the row here is `ScriptedAiAgent`, because none of these facts is Pi's: they are
 * the row's own declarations plus the generic core's initial state. The Pi transport is proven in
 * `restore/pi-restore.integration.test.ts`, on a real socket.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Redacted} from "effect";
import {afterAll, expect} from "vitest";
import {type AiAgentSessionState, isAiAgentSessionState} from "../ai-agent/core/index.ts";
import {checkpointFields} from "../ai-agent/restore/index.ts";
import {ScriptedAiAgent} from "../ai-agent/service/index.ts";
import {projectConfig} from "../boot.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";
import {PI_SESSION_PROGRAM, piSessionProgram, projectRootOf} from "./program.ts";
import {PI_CHAT_WINDOW_REF} from "./renderer-ref.ts";
import {makeScriptedHost} from "./server/fixtures.ts";
import {PiServerService} from "./server/index.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-program-")));
	tempDirs.push(dir);
	return dir;
};

const CWD_UNDER_TEST = tempProject();

const script = {
	sessionId: "pi-program-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	interrupt: [],
	turns: [],
};

const row = (cwd: string) => piSessionProgram({cwd, layer: ScriptedAiAgent.layer(script)});

const kernel = (cwd: string) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(memoryStores())),
		Layer.provide(Registry.layer([row(cwd)])),
	);

describe("the pi-session program row", () => {
	it("declares one node-placed row under the id a config module lists", () => {
		const cwd = tempProject();
		const declared = row(cwd);
		assert.strictEqual(declared.id, ProgramId.make(PI_SESSION_PROGRAM));
		assert.strictEqual(declared.identity.program, PI_SESSION_PROGRAM);
		assert.deepStrictEqual(declared.placement, {host: "local"});
		assert.deepStrictEqual(declared.capabilities, []);
		assert.deepStrictEqual(declared.renderer, PI_CHAT_WINDOW_REF);
		assert.isFunction(declared.resume, "a restored Pi session has no way back without a resume");
	});

	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = row(tempProject());
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(PI_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});

	it.effect("spawns through the registry and opens its session in the project root", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(PI_SESSION_PROGRAM), {
				id: ProcessId.make("pi"),
				services: Context.empty(),
			});
			const state = handle.getState();
			assert.isTrue(isAiAgentSessionState(state), "the spawned process holds no session state");
			assert.strictEqual((state as AiAgentSessionState).cwd, CWD_UNDER_TEST);
			assert.isNull((state as AiAgentSessionState).sessionId);
		}).pipe(Effect.scoped, Effect.provide(kernel(CWD_UNDER_TEST))),
	);

	it("reads the project root back off the config module's own location", () => {
		const project = tempProject();
		const moduleUrl = pathToFileURL(projectConfig(project));
		assert.strictEqual(
			projectRootOf(moduleUrl),
			project,
			"a project config module does not read back the root boot loaded it from",
		);
		assert.strictEqual(projectRootOf(moduleUrl.href), project);
	});
});

describe("the per-launch capability token", () => {
	it("is in no field a checkpoint carries", () => {
		expect(
			checkpointFields.filter((field) => /token|secret|url/i.test(field)),
			"a checkpoint field now looks like it could carry the loopback credential",
		).toEqual([]);
	});

	it.live("differs on every launch, so a restart's token is not the one before it", () =>
		Effect.gen(function* () {
			const host = makeScriptedHost();
			const tokenOnce = Effect.gen(function* () {
				const server = yield* PiServerService;
				return Redacted.value(server.token);
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(host.layer))),
			);
			const first = yield* tokenOnce;
			const second = yield* tokenOnce;
			assert.isNotEmpty(first);
			assert.notStrictEqual(first, second, "two launches minted one token");
		}),
	);
});
