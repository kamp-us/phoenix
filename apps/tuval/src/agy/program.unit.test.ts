/**
 * The `agy-session` row as a config module hands it over: what it declares, that the registry
 * spawns it, that a fresh session opens in the project root, that the two launch preconditions
 * refuse before a session rather than after a silent auto-denial, and that no checkpoint field
 * could carry a credential.
 *
 * The layer under the row is `ScriptedAiAgent`, for the reason `../pi/program.unit.test.ts` gives:
 * none of the row's declarations is agy's, and the `layer?` override is what lets them be checked
 * with no `agy` on `PATH`. The preflight is the exception and builds the real layer, because the
 * whole point of it is that it answers before the transport does. It is pointed at a temp `$HOME`
 * and at a four-line `sh` stub that answers `--version` and refuses every other argv, so no agy is
 * needed on `PATH` and no session is ever opened. The subprocess itself is proven in
 * `ai-agent/agy-ai-agent.integration.test.ts` against a scripted stand-in.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Fiber, Layer, Option, Stream} from "effect";
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
import {AGY_SETTINGS_FILE, AGY_VERSION} from "./config.ts";
import {
	type AgyVersionVerdict,
	agyVersionVerdict,
	preflightedAgyLayer,
	sandboxPreconditionDetail,
} from "./preflight.ts";
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

/**
 * The floor verdict over `agy --version`'s own text, with no agy installed: the whole point of the
 * pure half is that the three orderings and the two unreadable answers are string tests.
 *
 * The floor is read off `AGY_VERSION` rather than spelled `1.1.27` here, so the day the module is
 * captured against a newer release these keep asserting the ordering instead of reasserting a pin.
 */
describe("the version precondition's verdict", () => {
	const floor = AGY_VERSION.split(".").map(Number) as [number, number, number];
	const at = (major: number, minor: number, patch: number): string => `${major}.${minor}.${patch}`;

	it("proceeds on exactly the floor, and announces what it read", () => {
		assert.deepStrictEqual(agyVersionVerdict(`${AGY_VERSION}\n`), {
			kind: "supported",
			version: AGY_VERSION,
		});
	});

	it("proceeds above the floor on each of the three positions", () => {
		const above = [
			at(floor[0] + 1, 0, 0),
			at(floor[0], floor[1] + 1, 0),
			at(floor[0], floor[1], floor[2] + 1),
		];
		assert.deepStrictEqual(
			above.map((version) => agyVersionVerdict(version)),
			above.map((version): AgyVersionVerdict => ({kind: "supported", version})),
		);
	});

	it("refuses below the floor on each of the three positions, naming both versions and the fix", () => {
		const below = [
			...(floor[0] > 0 ? [at(floor[0] - 1, 99, 99)] : []),
			...(floor[1] > 0 ? [at(floor[0], floor[1] - 1, 99)] : []),
			...(floor[2] > 0 ? [at(floor[0], floor[1], floor[2] - 1)] : []),
		];
		assert.isTrue(below.length > 0, "the floor has no lower neighbour to refuse");
		for (const version of below) {
			const verdict = agyVersionVerdict(version);
			assert.strictEqual(verdict.kind, "refused");
			const detail = verdict.kind === "refused" ? verdict.detail : "";
			assert.include(detail, version);
			assert.include(detail, AGY_VERSION);
			assert.include(detail, "install agy");
		}
	});

	it("refuses a version it could not read rather than passing it silently", () => {
		// `null` is "the binary could not be run at all"; the other two are a binary that ran and
		// said nothing a release can be ordered against.
		const unreadable = [null, "", "antigravity (unknown build)"];
		assert.deepStrictEqual(
			unreadable.map((source) => agyVersionVerdict(source).kind),
			["refused", "refused", "refused"],
		);
	});

	it("reads the release out of a line that names more than the release", () => {
		assert.deepStrictEqual(agyVersionVerdict(`agy version ${AGY_VERSION} (darwin/arm64)`), {
			kind: "supported",
			version: AGY_VERSION,
		});
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

	/**
	 * A binary that answers `--version` with `version` and refuses every other argv.
	 *
	 * The transport arm needs one: the launch now reads the release before it hands over, so a
	 * binary that cannot be run answers the version precondition rather than the transport, and a
	 * name that does not resolve could no longer prove that a met precondition reaches the layer.
	 */
	const stubAgy = (home: string, version: string): string => {
		const path = join(home, "stub-agy");
		writeFileSync(
			path,
			`#!/bin/sh\ncase "$1" in --version) echo "${version}";; *) exit 1;; esac\n`,
			{
				mode: 0o755,
			},
		);
		return path;
	};

	const startOn = (home: string, binary: string = join(home, "no-such-agy")) =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			return yield* Effect.flip(agent.start({cwd: CWD_UNDER_TEST}));
		}).pipe(Effect.scoped, Effect.provide(preflightedAgyLayer({home, binary})));

	const configured = (): string => homeWith(JSON.stringify({toolPermission: "proceed-in-sandbox"}));

	/** The announcement proof builds its layer outside the effect, so its home is built with it. */
	const announcingHome = configured();

	it.effect("refuses the start rather than opening a session that cannot act", () =>
		Effect.gen(function* () {
			const error = yield* startOn(homeWith(null));
			assert.strictEqual(error.reason, "refused");
			assert.include(error.detail, "proceed-in-sandbox");
		}),
	);

	it.effect("refuses a binary below the floor before it opens a session on it", () =>
		Effect.gen(function* () {
			const home = configured();
			const error = yield* startOn(home, stubAgy(home, "0.9.0"));
			assert.strictEqual(error.reason, "refused");
			assert.include(error.detail, "0.9.0");
			assert.include(error.detail, AGY_VERSION);
		}),
	);

	it.effect("refuses a binary it cannot read a version out of", () =>
		Effect.gen(function* () {
			const error = yield* startOn(configured());
			assert.strictEqual(
				error.reason,
				"refused",
				"an unreadable version must be a named refusal, not a silent hand-over",
			);
			assert.include(error.detail, "agy --version");
		}),
	);

	it.effect("lets the transport answer once both preconditions are met", () =>
		Effect.gen(function* () {
			const home = configured();
			const error = yield* startOn(home, stubAgy(home, AGY_VERSION));
			assert.strictEqual(
				error.reason,
				"transport",
				"met preconditions must hand start to the layer instead of answering for it",
			);
		}),
	);

	it.effect("announces the version it read on events, before it hands over to the transport", () =>
		Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			// Subscribed before `start`, because the announcement is made on the way into it: a
			// subscription taken afterwards would be racing the transport's own failure.
			const watching = yield* Effect.forkChild(
				Stream.runHead(Stream.filter(agent.events, (event) => event.kind === "version")),
			);
			yield* Effect.flip(agent.start({cwd: CWD_UNDER_TEST}));
			assert.deepStrictEqual(
				yield* Fiber.join(watching),
				Option.some({kind: "version", version: AGY_VERSION}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				preflightedAgyLayer({home: announcingHome, binary: stubAgy(announcingHome, AGY_VERSION)}),
			),
		),
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
