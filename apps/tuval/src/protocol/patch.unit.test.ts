import {assert, describe, it} from "@effect/vitest";
import {Effect, Schema} from "effect";
import * as FC from "effect/testing/FastCheck";
import * as fixtures from "./fixtures.ts";
import {Patch, PROTOCOL_VERSION, type Replace, Snapshot} from "./messages.ts";
import {applyPatch} from "./patch.ts";

const {snapshot, workspace, leftWindow} = fixtures;

const replace = (path: ReadonlyArray<string>, value: unknown): Replace => ({
	op: "replace",
	path,
	value,
});

const patchOf = (changes: ReadonlyArray<Replace>, rev = snapshot.rev + 1) =>
	new Patch({type: "patch", version: PROTOCOL_VERSION, rev, changes});

/** Replaces the snapshot fixture actually addresses, each with a value of the field's own type. */
const replaceArbitrary: FC.Arbitrary<Replace> = FC.oneof(
	FC.string().map((name) => replace(["desk", "workspaces", workspace, "name"], name)),
	FC.constantFrom("row", "column").map((orientation) =>
		replace(["desk", "workspaces", workspace, "layout", "orientation"], orientation),
	),
	FC.string().map((id) => replace(["windows", leftWindow, "process"], id)),
	FC.integer({min: 0, max: 4096}).map((revision) =>
		replace(["processes", "0", "stateSummary", "revision"], revision),
	),
	FC.string().map((describe) => replace(["registry", "0", "describe"], describe)),
);

const workspaceKeys = new Set(Object.keys(snapshot.desk.workspaces[workspace] ?? {}));

describe("applyPatch", () => {
	it.effect.prop(
		"any run of replaces yields a value that decodes as a Snapshot",
		{changes: FC.array(replaceArbitrary, {maxLength: 8})},
		({changes}) =>
			Effect.gen(function* () {
				const patched = yield* applyPatch(snapshot, patchOf(changes));
				assert.strictEqual(patched.rev, snapshot.rev + 1);
				// The decode inside applyPatch is the claim; re-decoding the encoded form is the
				// independent check that what came back is a Snapshot and not a look-alike.
				const encoded = yield* Schema.encodeEffect(Snapshot)(patched);
				yield* Schema.decodeUnknownEffect(Snapshot)(encoded);
			}),
	);

	it.effect.prop(
		"a replace at a key the snapshot does not carry is refused",
		{key: FC.string({minLength: 1}).filter((key) => !workspaceKeys.has(key))},
		({key}) =>
			Effect.gen(function* () {
				const refusal = yield* Effect.flip(
					applyPatch(snapshot, patchOf([replace(["desk", "workspaces", workspace, key], 1)])),
				);
				assert.strictEqual(refusal._tag, "tuval/PatchRefused");
			}),
	);

	it.effect("applies the fixture patch", () =>
		Effect.gen(function* () {
			const patched = yield* applyPatch(snapshot, fixtures.patch);
			assert.strictEqual(patched.desk.workspaces[workspace]?.name, "renamed");
			assert.strictEqual(patched.rev, 8);
		}),
	);

	it.effect("refuses a patch that does not follow the snapshot's revision", () =>
		Effect.gen(function* () {
			const refusal = yield* Effect.flip(applyPatch(snapshot, patchOf([], snapshot.rev)));
			assert.strictEqual(refusal._tag, "tuval/PatchRefused");
			assert.include(refusal.message, "does not follow");
		}),
	);

	it.effect("refuses a replace with no path", () =>
		Effect.gen(function* () {
			const refusal = yield* Effect.flip(applyPatch(snapshot, patchOf([replace([], 1)])));
			assert.strictEqual(refusal._tag, "tuval/PatchRefused");
		}),
	);

	it.effect("refuses an index past the end of an array", () =>
		Effect.gen(function* () {
			const refusal = yield* Effect.flip(
				applyPatch(snapshot, patchOf([replace(["processes", "9"], null)])),
			);
			assert.strictEqual(refusal._tag, "tuval/PatchRefused");
		}),
	);

	it.effect("refuses a replace that would leave the snapshot undecodable", () =>
		Effect.gen(function* () {
			const refusal = yield* Effect.flip(
				applyPatch(snapshot, patchOf([replace(["desk", "workspaces", workspace, "name"], 7)])),
			);
			assert.strictEqual(refusal._tag, "tuval/ProtocolRefused");
		}),
	);
});
