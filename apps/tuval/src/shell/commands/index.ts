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
export {CommandDispatched, shellSpells} from "./spells.ts";
export {
	commandFor,
	commandNames,
	msgForCommandName,
	resolveVerb,
	shellCommands,
	verbSpellings,
} from "./table.ts";
