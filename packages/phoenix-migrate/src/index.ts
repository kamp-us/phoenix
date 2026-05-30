import * as Command from "effect/unstable/cli/Command";
import {newCommand} from "./commands/new.ts";

export const command = Command.make("phoenix-migrate").pipe(
	Command.withDescription(
		"phoenix CLI plumbing: scaffold and manage SQL migrations for Durable Objects.",
	),
	Command.withSubcommands([newCommand]),
);

export {newCommand};
