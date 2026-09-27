import {existsSync, mkdirSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Option} from "effect";
import {scratchHome} from "../scratch-home.ts";
import {
	advertiseDesk,
	type DeskRecord,
	deskRecordFile,
	readDeskRecord,
	removeDeskRecord,
	writeDeskRecord,
} from "./record.ts";
import {DeskProbe, sightDesk} from "./sighting.ts";

const record = (pid: number): DeskRecord => ({version: 1, pid, page: "http://localhost:5173/"});

/** A probe that answers for exactly the pids given, as a desk that is up would. */
const answering = (...pids: ReadonlyArray<number>) =>
	Layer.succeed(DeskProbe, {
		answer: (found) =>
			Effect.succeed(
				pids.includes(found.pid)
					? Option.some(`ws://127.0.0.1:1/?pid=${found.pid}`)
					: Option.none(),
			),
	});

const writeRaw = (home: string, text: string) => {
	const file = deskRecordFile(home);
	mkdirSync(dirname(file), {recursive: true});
	writeFileSync(file, text);
};

describe("the discovery record", () => {
	it.effect("round-trips under the home .tuval", () =>
		Effect.gen(function* () {
			const home = scratchHome("desk-record");
			assert.deepStrictEqual(yield* readDeskRecord(home), {_tag: "Absent"});
			yield* writeDeskRecord(home, record(7));
			assert.deepStrictEqual(yield* readDeskRecord(home), {_tag: "Found", record: record(7)});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("reads a file that is not a record as unreadable", () =>
		Effect.gen(function* () {
			const home = scratchHome("desk-record-garbled");
			writeRaw(home, "{not json");
			const read = yield* readDeskRecord(home);
			assert.strictEqual(read._tag, "Unreadable");
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("is removed only by the desk it names", () =>
		Effect.gen(function* () {
			const home = scratchHome("desk-record-owner");
			yield* writeDeskRecord(home, record(8));
			yield* removeDeskRecord(home, 7);
			assert.isTrue(existsSync(deskRecordFile(home)));
			yield* removeDeskRecord(home, 8);
			assert.isFalse(existsSync(deskRecordFile(home)));
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("advertises the desk while its scope is open, and takes the record away after", () =>
		Effect.gen(function* () {
			const home = scratchHome("desk-record-scope");
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* advertiseDesk(home, "http://localhost:5173/");
					const read = yield* readDeskRecord(home);
					assert.isTrue(read._tag === "Found" && read.record.pid === process.pid);
				}),
			);
			assert.isFalse(existsSync(deskRecordFile(home)));
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);

	it.effect("leaves a record a later desk wrote when an earlier desk stops", () =>
		Effect.gen(function* () {
			const home = scratchHome("desk-record-replaced");
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* advertiseDesk(home, "http://localhost:5173/");
					yield* writeDeskRecord(home, record(process.pid + 1));
				}),
			);
			assert.deepStrictEqual(yield* readDeskRecord(home), {
				_tag: "Found",
				record: record(process.pid + 1),
			});
		}).pipe(Effect.provide(NodeFileSystem.layer)),
	);
});

describe("sightDesk over fixture records", () => {
	it.effect("finds no desk under a home with no record", () =>
		Effect.gen(function* () {
			const sighting = yield* sightDesk(scratchHome("sight-none"));
			assert.deepStrictEqual(sighting, {_tag: "NoDesk"});
		}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, answering(7)))),
	);

	it.effect("finds the desk a record names once it answers", () =>
		Effect.gen(function* () {
			const home = scratchHome("sight-live");
			yield* writeDeskRecord(home, record(7));
			assert.deepStrictEqual(yield* sightDesk(home), {
				_tag: "Live",
				record: record(7),
				launchUrl: "ws://127.0.0.1:1/?pid=7",
			});
		}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, answering(7)))),
	);

	it.effect("calls a crashed desk's record stale", () =>
		Effect.gen(function* () {
			const home = scratchHome("sight-crashed");
			yield* writeDeskRecord(home, record(9));
			const sighting = yield* sightDesk(home);
			assert.deepStrictEqual(sighting, {
				_tag: "Stale",
				reason: "the desk it names (pid 9) does not answer",
				pid: 9,
			});
		}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, answering(7)))),
	);

	it.effect("clears a stale record, which the next sighting reads as no desk", () =>
		Effect.gen(function* () {
			const home = scratchHome("sight-cleared");
			writeRaw(home, "garbage");
			const sighting = yield* sightDesk(home);
			assert.isTrue(sighting._tag === "Stale" && sighting.pid === null);
			yield* removeDeskRecord(home, null);
			assert.deepStrictEqual(yield* sightDesk(home), {_tag: "NoDesk"});
		}).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, answering(7)))),
	);
});

describe("the real probe", () => {
	it.effect("calls a record whose process is gone stale without asking its page", () =>
		Effect.gen(function* () {
			// Well above any pid a machine hands out, so no process has it.
			const answer = yield* DeskProbe.use((probe) => probe.answer(record(2 ** 30)));
			assert.isTrue(Option.isNone(answer));
		}).pipe(Effect.provide(DeskProbe.layer)),
	);

	it.effect("calls a live process whose page does not answer stale", () =>
		Effect.gen(function* () {
			// This test's own pid is alive, and nothing listens on port 1.
			const answer = yield* DeskProbe.use((probe) =>
				probe.answer({version: 1, pid: process.pid, page: "http://127.0.0.1:1/"}),
			);
			assert.isTrue(Option.isNone(answer));
		}).pipe(Effect.provide(DeskProbe.layer)),
	);
});
