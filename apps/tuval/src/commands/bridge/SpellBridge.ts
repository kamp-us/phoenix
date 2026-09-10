/**
 * The program-blind bridge an agent program's SDK tool wraps (#7617 R2.4).
 *
 * `list` and `call` are the whole surface, and neither mentions a program: the Claude program's
 * `KernelBridge` (#7620) is a wrapper over this, and a second agent program costs an adapter and
 * no new spell (founder's walk on #7642, 2026-09-03). What makes it program-blind is where the
 * allowlist comes from — the calling program's own registry row supplies it, so no program id is
 * written in this directory.
 *
 * The allowance is a rule, never a snapshot: `call` resolves it at the moment of the call, so a
 * config reload that moves the registry moves what the bridge allows with it. Holding a list read
 * out of the live registry at layer build is what let `list` and `call` answer from two eras of one
 * config (#7743).
 *
 * `call` takes the caller's `Scope` and puts only its window on the wire: the executor re-resolves
 * the process from that window through `WindowIndex`, exactly as it does for a page, so a caller
 * cannot name a process by handing one to the bridge (#7617 R2.2).
 */

import {randomUUID} from "node:crypto";
import {Context, Effect, Layer} from "effect";
import {CallId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellFailure} from "../../protocol/messages.ts";
import {SpellExecutor} from "../executor.ts";
import {buildRegistry, describeSpell, type SpellDescription, SpellRegistry} from "../registry.ts";
import type {Client} from "../scope.ts";
import {type AnySpell, renderPath, type Scope, type SpellPath} from "../spell.ts";
import {SpellNotAllowed} from "./errors.ts";

/** One row of `SpellBridge.scripted`'s table: the spell it describes, and what calling it answers. */
export interface ScriptedCall {
	readonly spell: AnySpell;
	readonly answer: unknown;
}

/**
 * What `call` may reach. Both arms are rules rather than lists the layer holds: `every-registered`
 * is re-read from the registry on each call, and `paths` names constants the caller wrote down, so
 * neither can be a stale reading of state that has since moved.
 */
export type SpellAllowance =
	| {readonly kind: "every-registered"}
	| {readonly kind: "paths"; readonly paths: ReadonlyArray<SpellPath>};

/** Whatever the registry holds when the call is made — a reload moves `list` and `call` together. */
export const everyRegistered: SpellAllowance = {kind: "every-registered"};

/** Exactly these paths, whatever the registry holds. */
export const onlyPaths = (paths: ReadonlyArray<SpellPath>): SpellAllowance => ({
	kind: "paths",
	paths,
});

const clientOf = (scope: Scope): Client => ({id: scope.client, workspace: scope.workspace});

const make = Effect.fn("Tuval.SpellBridge.make")(function* (options: {
	readonly allow: SpellAllowance;
}) {
	const executor = yield* SpellExecutor;
	const registry = yield* SpellRegistry;
	const allowed: Effect.Effect<ReadonlySet<string>> =
		options.allow.kind === "paths"
			? Effect.succeed(new Set(options.allow.paths.map(renderPath)))
			: Effect.map(registry.list, (rows) => new Set(rows.map((row) => renderPath(row.path))));

	const call = Effect.fn("Tuval.SpellBridge.call")(function* (
		path: SpellPath,
		args: unknown,
		scope: Scope,
	) {
		const rendered = renderPath(path);
		// Refused before the executor is reached, so a path outside the allowlist never runs.
		if (!(yield* allowed).has(rendered)) return yield* new SpellNotAllowed({path: rendered});
		const reply = yield* executor.execute(
			new SpellCall({
				type: "spell.call",
				version: PROTOCOL_VERSION,
				id: CallId.make(randomUUID()),
				path,
				args,
				...(scope.window === undefined ? {} : {window: scope.window}),
			}),
			clientOf(scope),
		);
		if (reply.ok) return reply.result;
		return yield* Effect.fail(reply.error);
	});

	return SpellBridge.of({list: registry.describe, call});
});

/** The bridge's whole surface, named so a caller can hold one without holding the service. */
export interface SpellBridgeApi {
	readonly list: Effect.Effect<ReadonlyArray<SpellDescription>>;
	readonly call: (
		path: SpellPath,
		args: unknown,
		scope: Scope,
	) => Effect.Effect<unknown, SpellFailure | SpellNotAllowed>;
}

export class SpellBridge extends Context.Service<SpellBridge, SpellBridgeApi>()(
	"tuval/SpellBridge",
) {
	static readonly layer = (options: {
		readonly allow: SpellAllowance;
	}): Layer.Layer<SpellBridge, never, SpellExecutor | SpellRegistry> =>
		Layer.effect(SpellBridge, make(options));

	/**
	 * The bridge over a fixed table — the deterministic layer a caller's own tests use. It answers
	 * from the table and runs nothing, so it has no allowlist to enforce: what a scripted bridge
	 * describes is exactly what it answers.
	 */
	static readonly scripted = (table: ReadonlyArray<ScriptedCall>): Layer.Layer<SpellBridge> =>
		Layer.effect(
			SpellBridge,
			// Registration renders each spell's params, and a scripted table that cannot be
			// registered is a bug in the test that wrote it, so it dies rather than answering.
			Effect.map(
				buildRegistry({core: table.map(({spell}) => spell), programs: []}).pipe(Effect.orDie),
				(registered) =>
					SpellBridge.of({
						list: Effect.succeed(registered.rows.map(describeSpell)),
						call: (path) => {
							const rendered = renderPath(path);
							const row = table.find(({spell}) => renderPath(spell.path) === rendered);
							return row === undefined
								? Effect.fail({
										tag: "tuval/commands/UnknownSpell",
										message: `no spell is registered at path "${rendered}"`,
										path: [...path],
									} satisfies SpellFailure)
								: Effect.succeed(row.answer);
						},
					}),
			),
		);
}
