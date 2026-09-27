/**
 * The `pi-session` row as a config module hands it over: what it declares, that the registry
 * spawns it, that a fresh session's cwd is the project root the kernel booted from, and that the
 * per-launch capability token is nowhere near the checkpoint.
 *
 * The layer under the row here is `ScriptedAiAgent`, because none of these facts is Pi's: they are
 * the row's own declarations plus the generic core's initial state. The Pi transport is proven on a
 * real socket by the desk app's restore proof (`apps/tuval/src/pi-desk/restore/`), and the cases
 * that need the desk's picker or boot live beside it.
 */

import {mkdtempSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {ItemId, type TranscriptItem} from "@kampus/tuval-sdk/ai-agent/ports";
import {
	type AiAgentSessionState,
	initialState,
	isAiAgentSessionState,
} from "@kampus/tuval-sdk/kernel/ai-agent/core/index";
import {AI_AGENT_INSPECTOR_REF} from "@kampus/tuval-sdk/kernel/ai-agent/renderer-ref";
import {checkpointFields} from "@kampus/tuval-sdk/kernel/ai-agent/restore/index";
import {ScriptedAiAgent} from "@kampus/tuval-sdk/kernel/ai-agent/service/index";
import {
	ClientId,
	type Scope as SpellScope,
	WorkspaceId,
} from "@kampus/tuval-sdk/kernel/commands/spell";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {ProcessId} from "@kampus/tuval-sdk/kernel/process/process";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Context, Effect, Layer, Redacted} from "effect";
import {afterAll, expect} from "vitest";
import {
	PI_SESSION_PROGRAM,
	type PiSessionProgramOptions,
	piSessionProgram,
	projectRootOf,
} from "./program.ts";
import {PI_CHAT_WINDOW_REF} from "./renderer-ref.ts";
import {makeScriptedHost} from "./server/fixtures.ts";
import {type AgentSessionHostOptions, PiServerService} from "./server/index.ts";

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

/** The scope a row built without a substitute layer names; nothing here reaches a kernel through it. */
const PROBE_SCOPE = {
	workspace: WorkspaceId.make("default"),
	client: ClientId.make("pi-program-test"),
} satisfies SpellScope;

const script = {
	sessionId: "pi-program-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
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
		// The row claims `process-control` because it now really does spawn: its three kernel tools
		// reach the kernel through `KernelBridge` (#8720), the same claim the Claude and Codex rows make.
		assert.deepStrictEqual(declared.capabilities, [
			{
				family: "process-control",
				detail: "spawns, sends to and reads other processes through the three kernel tools",
			},
		]);
		assert.deepStrictEqual(declared.renderer, PI_CHAT_WINDOW_REF);
		assert.deepStrictEqual(
			declared.inspector,
			AI_AGENT_INSPECTOR_REF,
			"a row declaring no inspector leaves the desk with nothing to paint for a Pi session",
		);
		assert.isFunction(declared.resume, "a restored Pi session has no way back without a resume");
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

	it("lets a desk config ask for the reply as it is written", () => {
		const pi = {streamPartialText: true} satisfies NonNullable<PiSessionProgramOptions["pi"]>;
		// The key a config writes is the host's own option, not a second flag beside it: this is the
		// whole config path, since the row spreads `pi` straight onto `PiAiAgent.layer`'s options.
		const forwarded: Pick<AgentSessionHostOptions, "streamPartialText"> = pi;
		assert.strictEqual(forwarded.streamPartialText, true);
		assert.strictEqual(
			piSessionProgram({cwd: tempProject(), pi, scope: PROBE_SCOPE}).id,
			ProgramId.make(PI_SESSION_PROGRAM),
		);
	});

	/**
	 * #8170's rule, inherited rather than restated: `aiAgentProgram` sets
	 * `checkpointWorthy: (state) => !holdsPartialItem(state)`, so a Pi reply mid-flight is a state
	 * the row refuses to write the moment `itemOf` marks it partial.
	 */
	it("writes no checkpoint while a reply is still being written", () => {
		const declared = row(tempProject());
		const base = initialState(CWD_UNDER_TEST);
		const holding = (item: TranscriptItem): AiAgentSessionState => ({
			...base,
			transcript: {...base.transcript, items: [item]},
		});
		const settled = {
			kind: "assistant",
			id: ItemId.make("item-1"),
			timestamp: 11,
			text: "hi there",
		} as const satisfies TranscriptItem;
		assert.isFalse(declared.checkpointWorthy?.(holding({...settled, partial: true})));
		assert.isTrue(declared.checkpointWorthy?.(holding(settled)));
	});

	it("reads the project root two directories up from the config module", () => {
		const project = tempProject();
		const moduleUrl = pathToFileURL(join(project, ".tuval", "tuval.config.ts"));
		assert.strictEqual(projectRootOf(moduleUrl), project);
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
