/**
 * Applying a `Patch` over a `Snapshot`.
 *
 * A patch is path-addressed replaces on the snapshot's JSON form, so applying one is: encode, walk
 * each path, then decode the result back as a `Snapshot`. The decode is the point — a patch that
 * would leave the desk in a shape the protocol does not admit is refused here rather than delivered
 * to the page. A replace never creates a key: an unreachable path is a refusal, because a kernel
 * and a page that disagree about the shape should stop, not diverge quietly.
 */

import {Effect, Predicate, Schema} from "effect";
import {PatchRefused, ProtocolRefused} from "./errors.ts";
import {describeSchemaError} from "./issue.ts";
import type {Patch} from "./messages.ts";
import {Snapshot} from "./messages.ts";

type Replaced =
	| {readonly ok: true; readonly value: unknown}
	| {readonly ok: false; readonly reason: string};

declare const ArrayIndexOf: unique symbol;

/** An in-range index of some array. `indexInto` is its only constructor, so there is no other way
 * to reach `target[i]` — `Number` would have invented one out of `""`, `"0x2"`, `" 1 "` or `"1e0"`,
 * and four spellings addressing one element makes a patch's meaning a coercion rule's to decide. */
type ArrayIndex = number & {readonly [ArrayIndexOf]: true};

/** One spelling per index: digits only, and a leading zero only when the index *is* zero. */
const INDEX_SPELLING = /^(?:0|[1-9][0-9]*)$/;

const indexInto = (target: ReadonlyArray<unknown>, segment: string): ArrayIndex | undefined => {
	if (!INDEX_SPELLING.test(segment)) return undefined;
	const index = Number(segment) as ArrayIndex;
	return index < target.length ? index : undefined;
};

/** The walk recurses once per segment, and `Replace.path` is unbounded on the wire, so without a cap
 * a long enough path overflows the page's stack — a `RangeError`, which is outside `applyPatch`'s
 * error channel and so escapes as a defect rather than a refusal. The snapshot's own deepest
 * addressable path is five segments. */
const MAX_PATH_DEPTH = 32;

const replaceAt = (target: unknown, path: ReadonlyArray<string>, value: unknown): Replaced => {
	if (path.length > MAX_PATH_DEPTH) {
		return {ok: false, reason: `a path deeper than ${MAX_PATH_DEPTH} segments is not walked`};
	}
	const [head, ...rest] = path;
	if (head === undefined) return {ok: true, value};
	if (Array.isArray(target)) {
		const index = indexInto(target, head);
		if (index === undefined) {
			return {ok: false, reason: `"${head}" is not an index of the array there`};
		}
		const inner = replaceAt(target[index], rest, value);
		if (!inner.ok) return inner;
		const next = target.slice();
		next[index] = inner.value;
		return {ok: true, value: next};
	}
	if (!Predicate.isObject(target)) return {ok: false, reason: `nothing addressable at "${head}"`};
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
			if (change.path[0] === "rev") {
				// The revision write below would clobber it, so accepting one reports a change applied
				// that had no effect.
				return yield* new PatchRefused({
					path: change.path,
					reason: "the revision is the patch's own field, not a replace target",
				});
			}
			const replaced = replaceAt(current, change.path, change.value);
			if (!replaced.ok) {
				return yield* new PatchRefused({path: change.path, reason: replaced.reason});
			}
			current = replaced.value;
		}
		const withRevision = Predicate.isObject(current) ? {...current, rev: patch.rev} : current;
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
