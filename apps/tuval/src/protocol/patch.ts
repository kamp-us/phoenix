/**
 * Applying a `Patch` over a `Snapshot`.
 *
 * A patch is path-addressed replaces on the snapshot's JSON form, so applying one is: encode, walk
 * each path, then decode the result back as a `Snapshot`. The decode is the point — a patch that
 * would leave the desk in a shape the protocol does not admit is refused here rather than delivered
 * to the page. A replace never creates a key: an unreachable path is a refusal, because a kernel
 * and a page that disagree about the shape should stop, not diverge quietly.
 */

import {Effect, Schema} from "effect";
import {PatchRefused, ProtocolRefused} from "./errors.ts";
import {describeSchemaError} from "./issue.ts";
import {isRecord} from "./json.ts";
import type {Patch} from "./messages.ts";
import {Snapshot} from "./messages.ts";

type Replaced =
	| {readonly ok: true; readonly value: unknown}
	| {readonly ok: false; readonly reason: string};

const replaceAt = (target: unknown, path: ReadonlyArray<string>, value: unknown): Replaced => {
	const [head, ...rest] = path;
	if (head === undefined) return {ok: true, value};
	if (Array.isArray(target)) {
		const index = Number(head);
		if (!Number.isInteger(index) || index < 0 || index >= target.length) {
			return {ok: false, reason: `"${head}" is not an index of the array there`};
		}
		const inner = replaceAt(target[index], rest, value);
		if (!inner.ok) return inner;
		const next = target.slice();
		next[index] = inner.value;
		return {ok: true, value: next};
	}
	if (!isRecord(target)) return {ok: false, reason: `nothing addressable at "${head}"`};
	if (!Object.hasOwn(target, head)) return {ok: false, reason: `no key "${head}" there`};
	const inner = replaceAt(target[head], rest, value);
	if (!inner.ok) return inner;
	return {ok: true, value: {...target, [head]: inner.value}};
};

const encodeSnapshot = Schema.encodeEffect(Snapshot);
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);

export const applyPatch = (
	snapshot: Snapshot,
	patch: Patch,
): Effect.Effect<Snapshot, PatchRefused | ProtocolRefused> =>
	Effect.gen(function* () {
		if (patch.rev !== snapshot.rev + 1) {
			return yield* new PatchRefused({
				path: [],
				reason: `revision ${patch.rev} does not follow ${snapshot.rev}`,
			});
		}
		const encoded = yield* encodeSnapshot(snapshot).pipe(
			Effect.mapError(
				(error) =>
					new ProtocolRefused({
						direction: "kernel-to-page",
						reason: `snapshot does not encode: ${describeSchemaError(error)}`,
					}),
			),
		);
		let current: unknown = encoded;
		for (const change of patch.changes) {
			if (change.path.length === 0) {
				return yield* new PatchRefused({path: [], reason: "a replace needs a path"});
			}
			const replaced = replaceAt(current, change.path, change.value);
			if (!replaced.ok) {
				return yield* new PatchRefused({path: change.path, reason: replaced.reason});
			}
			current = replaced.value;
		}
		const withRevision = isRecord(current) ? {...current, rev: patch.rev} : current;
		return yield* decodeSnapshot(withRevision).pipe(
			Effect.mapError(
				(error) =>
					new ProtocolRefused({
						direction: "kernel-to-page",
						reason: `patched snapshot does not decode: ${describeSchemaError(error)}`,
					}),
			),
		);
	});
