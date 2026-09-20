/** The shell's named command rows, the command line that reads them, and their spells. */

export {ShellDispatch} from "./dispatch.ts";
export {
	badArgument,
	type CommandRefusal,
	emptyCommandLine,
	missingArgument,
	refusalMessage,
	tooManyArguments,
	unknownCommand,
} from "./errors.ts";
export {type CommandLineResult, readCommandLine} from "./line.ts";
export {
	type AnyShellCommand,
	type CommandPath,
	commandName,
	commandPath,
	defineCommand,
	parameterNames,
	type ShellCommand,
} from "./row.ts";
export {CommandDispatched, shellSpells, shellSpellsFor} from "./spells.ts";
export {
	type CommandIndex,
	commandFor,
	commandIndexFor,
	commandNames,
	msgForCommandName,
	noShellCommandFeatures,
	resolveVerb,
	type ShellCommandFeatures,
	shellCommandIndex,
	shellCommands,
	shellCommandsFor,
	verbSpellings,
} from "./table.ts";
