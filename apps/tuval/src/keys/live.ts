/**
 * The owner bindings a running desk's shell routes keys by (#9687), replaced whenever the config
 * generation is: at start, on every reload, and on every project open and close. The shell core
 * reads it at each key (`../shell/core/machine.ts`), so a project's bindings answer in its windows
 * from the moment it opens and stop the moment it closes, with the shell process never respawned.
 */

import type {RegistryTable} from "@kampus/tuval-sdk/kernel/commands/registry";
import {Effect} from "effect";
import type {KeyBindingsSource} from "../shell/core/index.ts";
import {compileOwnerBindings, type OwnerKeys} from "./compile.ts";
import {noOwnerBindings, type OwnerBindings} from "./scopes.ts";

export class LiveKeyBindings implements KeyBindingsSource {
	private bindings: OwnerBindings = noOwnerBindings;

	readonly current = (): OwnerBindings => this.bindings;

	/**
	 * Compile `owners` against the spells `table` registers and route by them from the next key on.
	 * The errors are the bindings that did not compile, each dropped on its own.
	 */
	readonly install = (owners: OwnerKeys, table: RegistryTable) =>
		Effect.flatMap(compileOwnerBindings(owners, table), ({bindings, errors}) =>
			Effect.sync(() => {
				this.bindings = bindings;
				return errors;
			}),
		);
}
