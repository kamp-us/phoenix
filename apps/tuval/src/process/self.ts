/**
 * What a running process knows about itself, as a service its own handlers may yield.
 *
 * Three things a row's handlers cannot otherwise reach, and all three are per-process: the
 * process's own `ProcessId`, so a handler can name the process it is running as the way Elixir's
 * `self()` is a free read (founder's ruling on #8757); its own Scope (#7513), so a handler that
 * acquires a resource for the life of the process acquires it there and the stop releases it
 * exactly once; and a read of the machine's committed state, so a Sub handler can publish a
 * projection of it on an out-port without keeping a second copy.
 *
 * `id` is a read and never a write: a relation is the kernel's to stamp from the process it is
 * interpreting for, so no authoring effect takes a process id as input to set one.
 *
 * `state` is `unknown` because the row's private types are erased at the registry (`ProcessRow`);
 * the program's own module owns the predicate that reads it back.
 */

import {Context, type Scope} from "effect";
import type {ProcessId} from "./process.ts";

export class ProcessSelf extends Context.Service<
	ProcessSelf,
	{
		readonly id: ProcessId;
		readonly scope: Scope.Scope;
		readonly state: () => unknown;
	}
>()("tuval/ProcessSelf") {}
