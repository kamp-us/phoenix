/**
 * What a running process knows about itself, as a service its own handlers may yield.
 *
 * Two things a row's handlers cannot otherwise reach, and both are per-process: the process's own
 * Scope (#7513), so a handler that acquires a resource for the life of the process acquires it
 * there and the stop releases it exactly once; and a read of the machine's committed state, so a
 * Sub handler can publish a projection of it on an out-port without keeping a second copy.
 *
 * `state` is `unknown` because the row's private types are erased at the registry (`ProcessRow`);
 * the program's own module owns the predicate that reads it back.
 */

import {Context, type Scope} from "effect";

export class ProcessSelf extends Context.Service<
	ProcessSelf,
	{
		readonly scope: Scope.Scope;
		readonly state: () => unknown;
	}
>()("tuval/ProcessSelf") {}
