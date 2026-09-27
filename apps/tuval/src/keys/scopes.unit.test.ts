import {assert, describe, it} from "@effect/vitest";
import {registry} from "@kampus/tuval-sdk/kernel/commands/bindings/fixtures";
import type {Binding} from "@kampus/tuval-sdk/kernel/commands/bindings/index";
import {
	applyKeysConfig,
	CommandName,
	defaultPrefixTable,
	prefixTableFor,
} from "@kampus/tuval-ui/keys";
import {Effect, Result} from "effect";
import {AuthoredModules} from "../authored-modules.ts";
import {ConfigGeneration} from "../config-generation.ts";
import {ProjectId} from "../project-id.ts";
import {compileOwnerBindings} from "./compile.ts";
import {RESERVED_COMMANDS, ReservedDeskKeys} from "./reserved.ts";
import {boardFocus, type Focus, KeyScopes, windowFocus} from "./scopes.ts";

const alpha = ProjectId.of("/work/alpha");
const beta = ProjectId.of("/work/beta");

const bound = (key: string, ...path: [string, ...Array<string>]): Binding => ({
	key,
	path,
	args: {},
});

/** With the board on, so its reserved chord is one the desk routes as well as refuses. */
const boardOn = prefixTableFor(defaultPrefixTable, {processBoard: true});

const scopes = KeyScopes.of({
	desk: boardOn,
	global: [bound("<c-y>", "workspace", "next")],
	projects: new Map([
		[alpha.key, [bound("<c-g>", "window", "close"), bound("<c-b>z", "window", "close")]],
		[beta.key, [bound("<c-g>", "workspace", "next")]],
	]),
});

const alphaWindow = windowFocus(alpha.scope("counter"));
const betaWindow = windowFocus(beta.scope("counter"));
/** A harness session's window: a global row, whichever project folder its session started in. */
const harnessWindow = windowFocus("claude");

const everyFocus: ReadonlyArray<readonly [string, Focus]> = [
	["the board", boardFocus],
	["a project window", alphaWindow],
	["another project's window", betaWindow],
	["a harness window", harnessWindow],
];

describe("ReservedDeskKeys", () => {
	it("reserves the prefix and the workspace, picker, board and close chords, and nothing else", () => {
		const reserved = ReservedDeskKeys.of(defaultPrefixTable);
		assert.deepStrictEqual(
			reserved.entries.map(([key, action]) => [
				key,
				action._tag === "Prefix" ? "prefix" : action.command,
			]),
			[
				["<c-b>", "prefix"],
				["<c-b>x", "window:close"],
				["<c-b>w", "window:pick"],
				["<c-b><c-h>", "workspace:previous"],
				["<c-b><c-l>", "workspace:next"],
				["<c-b>p", "desk:board-toggle"],
			],
		);
		assert.deepStrictEqual(
			new Set(
				reserved.entries.flatMap(([, action]) =>
					action._tag === "Command" ? [action.command] : [],
				),
			),
			RESERVED_COMMANDS,
		);
	});

	it("reads a key however it is spelled, and follows a rebound prefix", () => {
		const rebound = ReservedDeskKeys.of(
			Result.getOrThrow(applyKeysConfig(defaultPrefixTable, {prefix: "<c-a>"})),
		);
		// A modifier reads the same in either case; the key itself does not: `<c-B>` is ctrl-shift-b.
		assert.strictEqual(ReservedDeskKeys.of(defaultPrefixTable).actionOf("<c-B>x"), undefined);
		assert.strictEqual(ReservedDeskKeys.of(defaultPrefixTable).actionOf("<C-b>x")?._tag, "Command");
		assert.strictEqual(rebound.actionOf("<c-b>x"), undefined);
		assert.strictEqual(rebound.actionOf("<c-a>x")?._tag, "Command");
	});

	it("refuses the first reserved key a keys block binds, naming it as written", () => {
		const reserved = ReservedDeskKeys.of(defaultPrefixTable);
		assert.deepStrictEqual(reserved.refuseIn({"<c-g>": "help"}), Result.void);
		assert.deepStrictEqual(
			reserved.refuseIn({"<c-g>": "help", "<C-b>": "help"}),
			Result.fail(
				`binds "<C-b>", the desk's reserved key for the prefix; a project cannot rebind a reserved desk key`,
			),
		);
	});
});

describe("KeyScopes: the key table follows focus", () => {
	for (const [name, focus] of everyFocus) {
		it(`answers every reserved desk key from ${name}`, () => {
			for (const [key, action] of scopes.reserved.entries) {
				assert.deepStrictEqual(scopes.route(focus, key), {_tag: "Reserved", action});
			}
		});
	}

	it("fires a project's binding in that project's windows only", () => {
		assert.deepStrictEqual(scopes.route(alphaWindow, "<c-g>"), {
			_tag: "Bound",
			owner: {_tag: "Project", key: alpha.key},
			binding: bound("<c-g>", "window", "close"),
		});
		assert.deepStrictEqual(scopes.route(betaWindow, "<c-g>"), {
			_tag: "Bound",
			owner: {_tag: "Project", key: beta.key},
			binding: bound("<c-g>", "workspace", "next"),
		});
		assert.strictEqual(scopes.route(boardFocus, "<c-g>"), undefined);
		assert.strictEqual(scopes.route(harnessWindow, "<c-g>"), undefined);
	});

	it("gives the board the global config's bindings and never a project's", () => {
		assert.strictEqual(scopes.route(boardFocus, "<c-y>")?._tag, "Bound");
		assert.strictEqual(scopes.route(alphaWindow, "<c-y>"), undefined);
	});

	it("keeps a harness window on its program's bindings whichever project it opened in", () => {
		assert.deepStrictEqual(scopes.ownerOf(harnessWindow), {_tag: "Global"});
		assert.deepStrictEqual(scopes.route(harnessWindow, "<c-y>"), {
			_tag: "Bound",
			owner: {_tag: "Global"},
			binding: bound("<c-y>", "workspace", "next"),
		});
	});

	it("lets an owner shadow a shell chord in its own windows, and never a reserved one", () => {
		assert.strictEqual(scopes.route(alphaWindow, "<c-b>z")?._tag, "Bound");
		assert.deepStrictEqual(scopes.route(betaWindow, "<c-b>z"), {
			_tag: "Chord",
			command: CommandName.make("window:zoom"),
		});
		const shadowing = KeyScopes.of({
			desk: defaultPrefixTable,
			global: [],
			projects: new Map([[alpha.key, [bound("<c-b>x", "window", "close")]]]),
		});
		assert.strictEqual(shadowing.route(alphaWindow, "<c-b>x")?._tag, "Reserved");
	});

	it("gives an empty window the global config's bindings", () => {
		assert.deepStrictEqual(scopes.ownerOf(windowFocus(null)), {_tag: "Global"});
		assert.strictEqual(scopes.route(windowFocus(null), "<c-y>")?._tag, "Bound");
		assert.strictEqual(scopes.route(windowFocus(null), "<c-g>"), undefined);
	});

	it("leaves out a binding no press can complete: several keys with no prefix in front", () => {
		const unroutable = KeyScopes.of({
			desk: defaultPrefixTable,
			global: [bound("gg", "window", "close")],
			projects: new Map(),
		});
		assert.strictEqual(unroutable.route(boardFocus, "gg"), undefined);
		assert.strictEqual(unroutable.route(boardFocus, "g"), undefined);
	});

	it("owns no bindings for a project that has closed", () => {
		const gone = windowFocus(ProjectId.of("/work/gone").scope("counter"));
		assert.strictEqual(scopes.route(gone, "<c-g>"), undefined);
		assert.strictEqual(scopes.route(gone, "<c-b>x")?._tag, "Reserved");
	});
});

describe("compileOwnerBindings", () => {
	it.effect("compiles each owner's key sources from the config generation, apart", () =>
		Effect.gen(function* () {
			const generation = ConfigGeneration.of({
				programs: [],
				keys: [{file: "global .tuval/tuval.config.ts", bindings: {"<c-y>": "workspace next"}}],
				sources: [],
			}).withProject(
				{id: alpha, module: "/work/alpha/.tuval/tuval.config.ts"},
				{
					programs: [],
					keys: [
						{
							file: "project .tuval/tuval.config.ts",
							bindings: {"<c-g>": "window close", "<c-q>": "no such spell"},
						},
					],
					sources: [],
				},
				{files: [], modules: AuthoredModules.none},
			);
			const {bindings, errors} = yield* compileOwnerBindings(
				generation.ownerKeys,
				yield* registry(),
			);
			const compiled = KeyScopes.of({desk: defaultPrefixTable, ...bindings});
			assert.deepStrictEqual(
				errors.map((error) => [error.file, error.key]),
				[["project .tuval/tuval.config.ts", "<c-q>"]],
			);
			assert.strictEqual(compiled.route(alphaWindow, "<c-g>")?._tag, "Bound");
			assert.strictEqual(compiled.route(boardFocus, "<c-g>"), undefined);
			assert.strictEqual(compiled.route(boardFocus, "<c-y>")?._tag, "Bound");
		}),
	);
});
