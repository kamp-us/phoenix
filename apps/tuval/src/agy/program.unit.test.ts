/**
 * The `agy-session` row as a config module hands it over: what it declares, that the registry
 * spawns it, that a fresh session opens in the project root, that the launch precondition refuses
 * before a session rather than after a silent auto-denial, and that no checkpoint field could carry
 * a credential.
 *
 * The layer under the row is `ScriptedAiAgent`, for the reason `../pi/program.unit.test.ts` gives:
 * none of the row's declarations is agy's, and the `layer?` override is what lets them be checked
 * with no `agy` on `PATH`. The preflight is the exception and builds the real layer, because the
 * whole point of it is that it answers before the transport does — it is pointed at a temp `$HOME`
 * and a binary name that does not resolve, so nothing is spawned on either arm. The subprocess
 * itself is proven in `ai-agent/agy-ai-agent.integration.test.ts` against a scripted stand-in.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer} from "effect";
import {afterAll, expect} from "vitest";
import {type AiAgentSessionState, isAiAgentSessionState} from "../ai-agent/core/index.ts";
import {checkpointFields} from "../ai-agent/restore/index.ts";
import {ScriptedAiAgent, TuvalAiAgent} from "../ai-agent/service/index.ts";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {memoryStores} from "../durability/stores.ts";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {programEntries, showsInAWindow} from "../shell/picker/entries.ts";
import {AGY_SETTINGS_FILE} from "./config.ts";
import {preflightedAgyLayer, sandboxPreconditionDetail} from "./preflight.ts";
import {AGY_SESSION_PROGRAM, agySessionProgram} from "./program.ts";
import {AGY_CHAT_WINDOW_REF} from "./renderer-ref.ts";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const tempProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-agy-program-")));
	tempDirs.push(dir);
	return dir;
};

const CWD_UNDER_TEST = tempProject();

const script = {
	sessionId: "agy-program-test",
	history: [],
	modes: {current: null, available: []},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

const row = (cwd: string) => agySessionProgram({cwd, layer: ScriptedAiAgent.layer(script)});

const kernel = (cwd: string) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(memoryStores())),
		Layer.provide(Registry.layer([row(cwd)])),
	);

describe("the agy-session program row", () => {
	it("declares one node-placed row under the id a config module lists", () => {
		const declared = row(tempProject());
		assert.strictEqual(declared.id, ProgramId.make(AGY_SESSION_PROGRAM));
		assert.strictEqual(declared.identity.program, AGY_SESSION_PROGRAM);
		assert.deepStrictEqual(declared.placement, {host: "local"});
		assert.deepStrictEqual(
			declared.capabilities,
			[],
			"agy reaches no kernel tool, so a capability request here would say something false",
		);
		assert.deepStrictEqual(declared.renderer, AGY_CHAT_WINDOW_REF);
		assert.isFunction(declared.resume, "a restored agy session has no way back without a resume");
	});

	it("shows in the picker, which is what declaring a renderer buys the row", () => {
		const declared = row(tempProject());
		assert.isTrue(showsInAWindow(declared));
		assert.deepStrictEqual(
			programEntries([declared]).map((entry) => entry.programId),
			[ProgramId.make(AGY_SESSION_PROGRAM)],
			"a row the picker leaves out is a program nobody can open a window on",
		);
	});

	it.effect("spawns through the registry and opens its session in the project root", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(ProgramId.make(AGY_SESSION_PROGRAM), {
				id: ProcessId.make("agy"),
				services: Context.empty(),
			});
			const state = handle.getState();
			assert.isTrue(isAiAgentSessionState(state), "the spawned process holds no session state");
			assert.strictEqual((state as AiAgentSessionState).cwd, CWD_UNDER_TEST);
			assert.isNull((state as AiAgentSessionState).sessionId);
		}).pipe(Effect.scoped, Effect.provide(kernel(CWD_UNDER_TEST))),
	);
});

describe("the launch precondition the row checks before start", () => {
	const settings = (value: unknown): string => JSON.stringify({toolPermission: value});

	it("passes only the one setting that moves init.permission_mode", () => {
		assert.isNull(sandboxPreconditionDetail(settings("proceed-in-sandbox")));
	});

	it("refuses an absent file, naming the file and the fix", () => {
		const detail = sandboxPreconditionDetail(null);
		assert.include(detail ?? "", ".gemini/antigravity-cli/settings.json");
		assert.include(detail ?? "", "proceed-in-sandbox");
	});

	it("refuses the four desktop-app key names, which agy ignores", () => {
		const ignored = ["permissionMode", "permission_mode", "defaultMode", "autoExecutionPolicy"];
		const details = ignored.map((key) =>
			sandboxPreconditionDetail(JSON.stringify({[key]: "proceed-in-sandbox"})),
		);
		assert.deepStrictEqual(
			details.map((detail) => detail === null),
			[false, false, false, false],
		);
	});

	it("refuses a file that is not a JSON object rather than throwing on it", () => {
		const refusals = ["", "[]", '"proceed-in-sandbox"', settings("request-review")].map((source) =>
			sandboxPreconditionDetail(source),
		);
		assert.isTrue(refusals.every((detail) => detail !== null));
		for (const detail of refusals) assert.include(detail ?? "", "proceed-in-sandbox");
	});
});

describe("the preflighted layer the row builds when no layer is handed in", () => {
	const homeWith = (settings: string | null): string => {
		const home = tempProject();
		if (settings !== null) {
			mkdirSync(join(home, dirname(AGY_SETTINGS_FILE)), {recursive: true});
			writeFileSync(join(home, AGY_SETTINGS_FILE), settings);
		}
		return home;
	};

	const startOn = (home: string) =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			return yield* Effect.flip(agent.start({cwd: CWD_UNDER_TEST}));
		}).pipe(
			Effect.scoped,
			Effect.provide(preflightedAgyLayer({home, binary: join(home, "no-such-agy")})),
		);

	it.effect("refuses the start rather than opening a session that cannot act", () =>
		Effect.gen(function* () {
			const error = yield* startOn(homeWith(null));
			assert.strictEqual(error.reason, "refused");
			assert.include(error.detail, "proceed-in-sandbox");
		}),
	);

	it.effect("lets the transport answer once the precondition is met", () =>
		Effect.gen(function* () {
			const error = yield* startOn(
				homeWith(JSON.stringify({toolPermission: "proceed-in-sandbox"})),
			);
			assert.strictEqual(
				error.reason,
				"transport",
				"a met precondition must hand start to the layer instead of answering for it",
			);
		}),
	);
});

describe("the agy row's checkpoint", () => {
	it("carries no field that could hold a credential", () => {
		expect(
			checkpointFields.filter((field) => /token|secret|url/i.test(field)),
			"a checkpoint field now looks like it could carry a credential",
		).toEqual([]);
	});
});
