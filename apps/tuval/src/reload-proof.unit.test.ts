/**
 * The reload proof: a config read again replaces the spell registry and the key bindings in one
 * step, and a reader watching across the swap never catches one of them new beside the other old
 * (#7645).
 *
 * The config layer is `config-fixtures/reloadable.ts`, whose programs, spells and keys come from a
 * JSON file this test rewrites between the two loads, so the second load is a genuinely different
 * config rather than a second call over the same one.
 */

import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, type FileSystem, Schema, type Scope} from "effect";
import {afterEach} from "vitest";
import {type Booted, boot, coreSpells, projectDir} from "./boot.ts";
import {HelpRows} from "./commands/core/help.ts";
import {SpellExecutor} from "./commands/executor.ts";
import {ClientId, renderPath, WorkspaceId} from "./commands/spell.ts";
import {SpellSet} from "./commands/spell-set.ts";
import type {DeclaredConfig} from "./config-fixtures/reloadable.ts";
import {CallId} from "./protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall} from "./protocol/messages.ts";

const reloadable = fileURLToPath(new URL("./config-fixtures/reloadable.ts", import.meta.url));

const client = {id: ClientId.make("test"), workspace: WorkspaceId.make("ws-1")};

const tempDirs: string[] = [];
const freshDir = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
	delete process.env.TUVAL_RELOAD_FIXTURE;
});

/** Two programs, one spell each, both bound to a key. */
const first: DeclaredConfig = {
	programs: [
		{id: "alpha", spells: ["say"]},
		{id: "beta", spells: ["greet"]},
	],
	keys: {"ctrl-a": "alpha say", "ctrl-b": "beta greet"},
};

/**
 * `alpha`'s spell is renamed, so the key still bound to the old name no longer compiles. The new
 * name is one edit away and the old name is not a prefix of it, which is what makes the refusal
 * carry a suggestion: a name the old one still prefixes reads as a line someone is halfway through
 * typing, and that refusal has nothing to suggest.
 */
const second: DeclaredConfig = {
	programs: [
		{id: "alpha", spells: ["sey"]},
		{id: "beta", spells: ["greet"]},
	],
	keys: first.keys,
};

const declare = (path: string, config: DeclaredConfig) =>
	writeFileSync(path, JSON.stringify(config));

/** A booted app over the reloadable layer, its fixture file already holding `first`. */
const bootReloadable = Effect.fnUntraced(function* () {
	const project = freshDir("tuval-reload-");
	mkdirSync(projectDir(project));
	const declaration = join(freshDir("tuval-declared-"), "config.json");
	declare(declaration, first);
	process.env.TUVAL_RELOAD_FIXTURE = declaration;
	const booted = yield* boot({global: reloadable, project});
	return {booted, declaration};
});

const spellPaths = (booted: Booted) =>
	SpellSet.use((set) => set.read).pipe(
		Effect.map((state) => state.table.rows.map((row) => renderPath(row.path))),
		Effect.provideContext(booted.kernel),
	);

/** `help` as a person runs it, through the executor the kernel wired. */
const help = (booted: Booted) =>
	Effect.gen(function* () {
		const executor = yield* SpellExecutor;
		const reply = yield* executor.execute(
			new SpellCall({
				type: "spell.call",
				version: PROTOCOL_VERSION,
				id: CallId.make("help-1"),
				path: ["help"],
				args: {},
			}),
			client,
		);
		assert.isTrue(reply.ok, "help failed");
		return yield* Schema.decodeUnknownEffect(HelpRows)(reply.ok ? reply.result : undefined).pipe(
			Effect.orDie,
		);
	}).pipe(Effect.provideContext(booted.kernel));

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer));

describe("a config reload", () => {
	it.live("registers the reloaded config's spells and drops the ones it removed", () =>
		run(
			Effect.gen(function* () {
				const {booted, declaration} = yield* bootReloadable();
				assert.strictEqual(booted.report.spellCount, coreSpells.length + 2);
				assert.deepStrictEqual(booted.report.bindingErrors, []);
				assert.strictEqual(booted.report.bindingCount, 2);
				assert.includeMembers(yield* spellPaths(booted), ["alpha.say", "beta.greet"]);
				assert.includeMembers(
					(yield* help(booted)).map((row) => row.path),
					["alpha say", "beta greet"],
					"help did not list the config's spells",
				);

				declare(declaration, second);
				const report = yield* booted.reload;

				assert.strictEqual(report.spellCount, coreSpells.length + 2);
				const paths = yield* spellPaths(booted);
				assert.includeMembers(paths, ["alpha.sey", "beta.greet"]);
				assert.notInclude(paths, "alpha.say", "the renamed spell is still registered");
				const rows = (yield* help(booted)).map((row) => row.path);
				assert.includeMembers(rows, ["alpha sey"], "help did not reflect the reload");
				assert.notInclude(rows, "alpha say", "help still lists the spell the reload removed");
			}),
		),
	);

	it.live(
		"reports the binding that stopped compiling, pointing at the segment that went away, and keeps the rest",
		() =>
			run(
				Effect.gen(function* () {
					const {booted, declaration} = yield* bootReloadable();
					declare(declaration, second);
					const report = yield* booted.reload;

					assert.strictEqual(report.bindingErrors.length, 1, "expected one binding to have broken");
					const [broken] = report.bindingErrors;
					assert.isDefined(broken);
					assert.strictEqual(broken?.key, "ctrl-a");
					assert.strictEqual(broken?.file, "global config-fixtures/reloadable.ts");
					assert.isTrue((broken?.position ?? -1) >= 0, "the error points at no position");
					assert.isTrue((broken?.expected ?? "").length > 0, "the error expects nothing");
					// `alpha` has exactly one child after the rename, so the nearest match to `say` is the
					// expectation itself and the hint is dropped rather than repeating it (#7745).
					assert.isUndefined(broken?.didYouMean, "the hint repeated the expectation");
					assert.strictEqual(
						broken?.message,
						'global config-fixtures/reloadable.ts: cannot bind "ctrl-a": at character 6, expected sey',
						"the parts did not render in order",
					);
					assert.notInclude(
						broken?.message ?? "",
						tmpdir(),
						"a binding error named a machine path",
					);

					const state = yield* SpellSet.use((set) => set.read).pipe(
						Effect.provideContext(booted.kernel),
					);
					assert.deepStrictEqual(
						state.bindings.bindings.map((binding) => binding.key),
						["ctrl-b"],
						"the binding that still compiles did not survive the reload",
					);
				}),
			),
	);

	it.live("swaps the registry and the binding table in one step, with no window between them", () =>
		run(
			Effect.gen(function* () {
				const {booted, declaration} = yield* bootReloadable();
				declare(declaration, second);

				const observations: Array<{
					readonly paths: ReadonlyArray<string>;
					readonly bound: ReadonlyArray<string>;
				}> = [];
				const watch = SpellSet.use((set) => set.read).pipe(
					Effect.flatMap((state) =>
						Effect.sync(() => {
							observations.push({
								paths: state.table.rows.map((row) => renderPath(row.path)),
								bound: state.bindings.bindings.map((binding) => renderPath(binding.path)),
							});
						}),
					),
					Effect.provideContext(booted.kernel),
				);
				const reader = yield* Effect.forkChild(Effect.forever(watch));

				yield* booted.reload;
				// The reader has to run once more after the swap, or the last sample it took is the
				// one from before it and the check below would pass without ever seeing the new pair.
				yield* Effect.sleep("5 millis");
				yield* Fiber.interrupt(reader);

				assert.isTrue(observations.length > 1, "the reader took no samples across the reload");
				for (const observed of observations) {
					// The one thing a half-replaced pair would show: a binding compiled against a table
					// that no longer holds the spell it points at.
					for (const bound of observed.bound) {
						assert.include(
							observed.paths,
							bound,
							"a binding was observed beside a registry that does not hold its spell",
						);
					}
				}
				const last = observations.at(-1);
				assert.include(last?.paths ?? [], "alpha.sey", "the reader never saw the reloaded table");
				assert.deepStrictEqual(
					last?.bound,
					["beta.greet"],
					"the reader never saw the reloaded bindings",
				);
			}),
		),
	);
});
