/**
 * The kernel side of one call: a `SpellCall` in, a `SpellReply` out (#7617 R2.2).
 *
 * Every way a call can go wrong is a reply, so the executor's own error channel is `never` and a
 * caller has one thing to read. The one exception is a spell whose value its own `result` schema
 * refuses: that is the spell author's bug, not the caller's, so it dies.
 *
 * `AnySpell` erases each spell's requirements, so nothing checks that the runtime carries what a
 * registered spell needs — the composition root that builds the registry owes those services, and
 * the single conversion in `runSpell` is where that obligation is spent. `src/boot.ts` is that
 * root and discharges it there: `WindowIndex` and `shellDispatchKernel` are built into the same
 * `Kernel` context a caller runs a spell under, and `Kernel` names both, so a dropped provider is
 * a compile error at `start` rather than a defect at the first call (#7774).
 */

import {Context, Effect, Layer, Schema} from "effect";
import {firstSchemaIssue} from "../protocol/issue.ts";
import {
	PROTOCOL_VERSION,
	type SpellCall,
	type SpellFailure,
	type SpellReply,
	SpellReplyError,
	SpellReplyOk,
} from "../protocol/messages.ts";
import {BadArgs, BadResult, SpellFailed, UnknownSpell} from "./errors.ts";
import {SpellRegistry, type SpellRow} from "./registry.ts";
import {type Client, resolveScope, WindowIndex} from "./scope.ts";
import {renderPath, type Scope, type SpellPath} from "./spell.ts";

/** Levenshtein distance, the measure behind the did-you-mean on an unknown path. */
const distance = (left: string, right: string): number => {
	let previous = Array.from({length: right.length + 1}, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			const substitute = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
			current.push(Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, substitute));
		}
		previous = current;
	}
	return previous[right.length] ?? 0;
};

/**
 * The nearest registered path, when one is near enough to be a typo rather than a different spell.
 * A third of the candidate's length is the budget, so `window.split` tolerates four edits and a
 * short path tolerates one.
 */
const nearestPath = (target: string, rows: ReadonlyArray<SpellRow>): string | undefined => {
	let best: {readonly path: string; readonly gap: number} | undefined;
	for (const row of rows) {
		const path = renderPath(row.path);
		const gap = distance(target, path);
		if (gap > Math.max(1, Math.ceil(path.length / 3))) continue;
		if (best === undefined || gap < best.gap) best = {path, gap};
	}
	return best?.path;
};

/** An error that names itself: a `_tag` to discriminate on, and whatever it renders as. */
type NamedError = {readonly _tag: string; readonly message?: unknown};

const isNamed = (value: unknown): value is NamedError =>
	typeof value === "object" && value !== null && typeof (value as NamedError)._tag === "string";

/**
 * The caught value as an error that names itself. One already carrying a `_tag` is its own;
 * anything else becomes `SpellFailed`, a class `errors.ts` declares, so the only source of a
 * reply's tag is an error object and no reply can carry a tag naming nothing in the tree.
 */
const named = (call: SpellCall, error: unknown): NamedError =>
	isNamed(error)
		? error
		: new SpellFailed({path: renderPath(call.path as SpellPath), original: error});

const messageOf = (error: NamedError): string =>
	typeof error.message === "string" && error.message.length > 0
		? error.message
		: `the call failed with ${error._tag}`;

/**
 * A failure as the page reads it. The spell path is always the call's own, so a spell's private
 * error cannot claim a different one; only the executor's own errors add `expected`/`didYouMean`.
 */
const failureOf = (call: SpellCall, error: NamedError): SpellFailure => {
	const base = {tag: error._tag, message: messageOf(error), path: call.path};
	if (error instanceof UnknownSpell && error.didYouMean !== undefined) {
		return {...base, didYouMean: error.didYouMean};
	}
	if (error instanceof BadArgs) return {...base, expected: error.expected};
	return base;
};

const succeeded = (call: SpellCall, result: unknown): SpellReply =>
	new SpellReplyOk({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: call.id,
		ok: true,
		result,
	});

const refused = (call: SpellCall, error: SpellFailure): SpellReply =>
	new SpellReplyError({
		type: "spell.reply",
		version: PROTOCOL_VERSION,
		id: call.id,
		ok: false,
		error,
	});

const runSpell = (row: SpellRow, args: unknown, scope: Scope): Effect.Effect<unknown, unknown> =>
	// The registry stores `AnySpell`, so this call's types — its requirements included — are `any`
	// here and the checker can prove nothing about them. See the module note.
	row.spell.execute(args, scope) as Effect.Effect<unknown, unknown>;

const make = Effect.fn("Tuval.SpellExecutor.make")(function* () {
	const registry = yield* SpellRegistry;
	const index = yield* WindowIndex;

	const lookup = (path: SpellPath) =>
		registry.lookup(path).pipe(
			Effect.catch((miss) =>
				Effect.flatMap(registry.list, (rows) => {
					const didYouMean = nearestPath(miss.path, rows);
					return Effect.fail(
						new UnknownSpell({
							path: miss.path,
							...(didYouMean === undefined ? {} : {didYouMean}),
						}),
					);
				}),
			),
		);

	// A row's schemas are `any` too, so their decoding/encoding services are erased with the rest of
	// the spell; these two conversions carry the same obligation `runSpell`'s does.
	const decodeArgs = (row: SpellRow, call: SpellCall) =>
		(
			Schema.decodeUnknownEffect(row.spell.params)(call.args) as Effect.Effect<
				unknown,
				Schema.SchemaError
			>
		).pipe(
			Effect.mapError((error) => {
				const {expected, at} = firstSchemaIssue(error);
				return new BadArgs({path: renderPath(row.path), argument: at, expected});
			}),
		);

	const encodeResult = (row: SpellRow, value: unknown) =>
		(
			Schema.encodeUnknownEffect(row.spell.result)(value) as Effect.Effect<
				unknown,
				Schema.SchemaError
			>
		).pipe(
			Effect.mapError(
				(error) =>
					new BadResult({path: renderPath(row.path), reason: firstSchemaIssue(error).expected}),
			),
			Effect.orDie,
		);

	const execute = Effect.fn("Tuval.SpellExecutor.execute")(function* (
		call: SpellCall,
		client: Client,
	) {
		const attempt = Effect.gen(function* () {
			// The wire schema checks the path is non-empty, so an empty one is unrepresentable here.
			const row = yield* lookup(call.path as SpellPath);
			const args = yield* decodeArgs(row, call);
			const scope = yield* resolveScope(call, client);
			const value = yield* runSpell(row, args, scope);
			return succeeded(call, yield* encodeResult(row, value));
		});
		return yield* attempt.pipe(
			Effect.provideService(WindowIndex, index),
			Effect.catch((error) => {
				const failure = named(call, error);
				const reply = refused(call, failureOf(call, failure));
				// The reply carries only what the wire can hold, so the value itself is logged here
				// or it is readable nowhere once this frame goes.
				return failure instanceof SpellFailed
					? Effect.logError("spell executor: a spell failed with an untagged value", {
							path: failure.path,
							original: failure.original,
						}).pipe(Effect.as(reply))
					: Effect.succeed(reply);
			}),
		);
	});

	return SpellExecutor.of({execute});
});

export class SpellExecutor extends Context.Service<
	SpellExecutor,
	{
		readonly execute: (call: SpellCall, client: Client) => Effect.Effect<SpellReply>;
	}
>()("tuval/SpellExecutor") {
	static readonly layer: Layer.Layer<SpellExecutor, never, SpellRegistry | WindowIndex> =
		Layer.effect(SpellExecutor, make());
}
