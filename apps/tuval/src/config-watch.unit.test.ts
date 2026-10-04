/**
 * The desk's hot reload trigger (#9667): saving a file the config was read from reloads, saving
 * anything else does not, and a reload moves the watch onto the files the new config was read from.
 * A save during a reload and a fix to a file only a refused config imported each reload too.
 * The reload itself is a counter here; `./reload-proof.unit.test.ts` owns what a reload does.
 */

import {mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Ref, Schedule} from "effect";
import {afterEach} from "vitest";
import {ConfigLoadError} from "./config.ts";
import {watchConfig} from "./config-watch.ts";
import {ReloadRefused, type ReloadReport} from "./reload.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

const freshDir = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-watch-")));
	tempDirs.push(dir);
	return dir;
};

const report = (files: ReadonlyArray<string>): ReloadReport => ({
	sources: [],
	files,
	spellCount: 0,
	bindingCount: 0,
	bindingErrors: [],
	notified: 0,
	switched: [],
	restoreRefused: [],
	pending: [],
});

/** Long enough for the OS to arm a fresh directory watch before the test writes. */
const ARMED = "150 millis";

/** Waits, bounded, for the reload count to reach `count`, and answers the count it saw. */
const reloadsReach = (reloads: Ref.Ref<number>, count: number) =>
	Ref.get(reloads).pipe(
		Effect.repeat({until: (seen) => seen >= count, schedule: Schedule.spaced("10 millis")}),
		Effect.timeoutOrElse({duration: "3 seconds", orElse: () => Ref.get(reloads)}),
	);

describe("watching the config's files", () => {
	it.live("reloads once when a watched file is saved, and not for its neighbour", () =>
		Effect.gen(function* () {
			const dir = freshDir();
			const config = join(dir, "tuval.config.ts");
			const program = join(dir, "program.ts");
			const neighbour = join(dir, "notes.md");
			for (const file of [config, program, neighbour]) writeFileSync(file, "// one\n");
			const reloads = yield* Ref.make(0);
			const watcher = yield* Effect.forkChild(
				watchConfig({
					files: [config, program],
					reload: Ref.updateAndGet(reloads, (n) => n + 1).pipe(
						Effect.as(report([config, program])),
					),
				}),
			);
			yield* Effect.sleep(ARMED);

			writeFileSync(neighbour, "// two\n");
			yield* Effect.sleep("300 millis");
			assert.strictEqual(yield* Ref.get(reloads), 0, "saving an unwatched file reloaded");

			writeFileSync(program, "// two\n");
			assert.strictEqual(
				yield* reloadsReach(reloads, 1),
				1,
				"saving a program file never reloaded",
			);

			yield* Fiber.interrupt(watcher);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.live("moves onto the files the reloaded config was read from", () =>
		Effect.gen(function* () {
			const config = join(freshDir(), "tuval.config.ts");
			const added = join(freshDir(), "added.ts");
			for (const file of [config, added]) writeFileSync(file, "// one\n");
			const reloads = yield* Ref.make(0);
			const watcher = yield* Effect.forkChild(
				watchConfig({
					files: [config],
					reload: Ref.updateAndGet(reloads, (n) => n + 1).pipe(Effect.as(report([config, added]))),
				}),
			);
			yield* Effect.sleep(ARMED);

			writeFileSync(config, "// two\n");
			assert.strictEqual(yield* reloadsReach(reloads, 1), 1, "saving the config never reloaded");
			yield* Effect.sleep(ARMED);

			writeFileSync(added, "// two\n");
			assert.strictEqual(
				yield* reloadsReach(reloads, 2),
				2,
				"a file the reloaded config imports was not watched",
			);

			yield* Fiber.interrupt(watcher);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.live("reloads again for a save that lands while a reload is running", () =>
		Effect.gen(function* () {
			const dir = freshDir();
			const config = join(dir, "tuval.config.ts");
			const program = join(dir, "program.ts");
			for (const file of [config, program]) writeFileSync(file, "// one\n");
			const reloads = yield* Ref.make(0);
			const watcher = yield* Effect.forkChild(
				watchConfig({
					files: [config, program],
					reload: Effect.gen(function* () {
						const count = yield* Ref.updateAndGet(reloads, (n) => n + 1);
						// The first reload has read the files when the author saves again, and it is still
						// running, so no watch is armed to see the event.
						if (count === 1) {
							writeFileSync(program, "// three\n");
							yield* Effect.sleep("200 millis");
						}
						return report([config, program]);
					}),
				}),
			);
			yield* Effect.sleep(ARMED);

			writeFileSync(program, "// two\n");
			assert.strictEqual(
				yield* reloadsReach(reloads, 2),
				2,
				"a save during the reload never reloaded",
			);
			yield* Effect.sleep("300 millis");
			assert.strictEqual(yield* Ref.get(reloads), 2, "the second reload reloaded again unasked");

			yield* Fiber.interrupt(watcher);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.live("watches the files a refused reload imported, so fixing a new one reloads", () =>
		Effect.gen(function* () {
			const config = join(freshDir(), "tuval.config.ts");
			const broken = join(freshDir(), "broken.ts");
			for (const file of [config, broken]) writeFileSync(file, "// one\n");
			const reloads = yield* Ref.make(0);
			const refused = new ReloadRefused({
				reason: new ConfigLoadError({
					module: config,
					reason: "module threw while loading: broken.ts",
					files: [config, broken],
				}),
				files: [config, broken],
			});
			const watcher = yield* Effect.forkChild(
				watchConfig({
					files: [config],
					reload: Ref.updateAndGet(reloads, (n) => n + 1).pipe(
						Effect.flatMap((count) =>
							count === 1 ? Effect.fail(refused) : Effect.succeed(report([config, broken])),
						),
					),
				}),
			);
			yield* Effect.sleep(ARMED);

			writeFileSync(config, "// imports broken.ts\n");
			assert.strictEqual(yield* reloadsReach(reloads, 1), 1, "saving the config never reloaded");
			yield* Effect.sleep(ARMED);

			writeFileSync(broken, "// fixed\n");
			assert.strictEqual(
				yield* reloadsReach(reloads, 2),
				2,
				"fixing the file that refused the reload never reloaded",
			);

			yield* Fiber.interrupt(watcher);
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});
