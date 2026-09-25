/**
 * `defineMachine` over the core a row carries, whose `subs` are `{type, deps}` entries.
 *
 * `@demlik/tea` 0.12's own `defineMachine` types `subs` in its inline-runner shape, so a core built
 * through it cannot declare a 0.18-shaped entry and is not a `ProgramCore`. This one takes the same
 * two update forms and delegates to tea's for the form stamp; the pin child (#9787) returns every
 * caller to tea's `defineMachine`, whose 0.18 signature already takes these entries.
 */

import {type Cmd, type Reducer, defineMachine as stampForm, type Transitions} from "@demlik/tea";
import type {ProgramCore} from "./program.ts";
import type {Sub} from "./sub.ts";

export type {ProgramCore};

type CoreInput<
	S,
	M extends {readonly type: string},
	C extends Cmd,
	U extends Sub,
	Ctx,
	Update,
> = Omit<ProgramCore<S, M, C, U, Ctx>, "update"> & {readonly update: Update};

export function defineMachine<S, M extends {type: string}, C extends Cmd, U extends Sub, Ctx>(
	core: CoreInput<S, M, C, U, Ctx, [S] extends [{type: string}] ? Transitions<S, M, C> : never>,
): ProgramCore<S, M, C, U, Ctx>;
export function defineMachine<S, M extends {type: string}, C extends Cmd, U extends Sub, Ctx>(
	core: CoreInput<S, M, C, U, Ctx, Reducer<S, M, C>>,
): ProgramCore<S, M, C, U, Ctx>;
export function defineMachine(core: object): object {
	// tea stamps the update form on the object it is handed and returns that object; the `subs` it
	// would type in its own shape are never read by it.
	return stampForm(core as Parameters<typeof stampForm>[0]);
}
