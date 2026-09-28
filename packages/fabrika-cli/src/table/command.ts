/**
 * The `table` verb group — `fabrika table <setup|sync|flags|prep|migrate-week>`.
 *
 * The adapter and nothing else: flags, the pure verb, and its emitted outcome. Every leaf is a
 * `leafCommand`, never a bare `Command.make`, so the excess-operand guard covers it.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {flagsBoard, runFlags} from "./flags-verb.ts";
import {migrateBoard, runMigrate} from "./migrate-verb.ts";
import {prepBoard, runPrep} from "./prep-verb.ts";
import {runSetup} from "./setup-verb.ts";
import {runSync, syncBoard} from "./sync-verb.ts";

/** A leaf's help in the leaf help rule's shape, ending on the pointer to its contract section. */
const tableHelp = (verb: string, lines: ReadonlyArray<string>): string =>
	[...lines, `  Derivation: the fabrika plugin's docs/table-contract.md, "${verb}"`].join("\n");

const setup = leafCommand(
	"setup",
	{
		repo: Flag.string("repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
			),
		),
	},
	Effect.fn(function* ({repo}) {
		yield* emit(
			yield* runSetup({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Create or reconcile the repository's betting table project."),
	Command.withDescription(
		tableHelp("table setup", [
			'Creates or reconciles the betting table project; prints {"answer","project","changes","legacy",…}.',
			"  7: a configured project number names no project",
			"  8: a write did not land (UNKNOWN); re-run",
			"  9: the project does not read back as the table",
			"  11: the repository or project was unreadable (UNKNOWN)",
			"  12: the table, appetiteSizes or boards block does not decode",
			"  20: the token lacks the project scope",
			"  21: a needed field exists with another type",
			"  22: two open projects carry the table's title",
		]),
	),
	Command.withExamples([{command: "fabrika table setup"}]),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		'read everything, send no write, and print every write it would send under answer "dry-run"',
	),
);

const sync = leafCommand(
	"sync",
	{
		issues: Argument.integer("issue").pipe(
			Argument.withDescription("an issue to sync; none syncs every issue already on the table"),
			Argument.atLeast(0),
		),
		repo: repoFlag,
		dryRun: dryRunFlag,
	},
	Effect.fn(function* ({issues, repo, dryRun}) {
		yield* emit(
			yield* runSync({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				issues,
				board: syncBoard,
				dryRun,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Fill the table's columns from the lane records on its issues."),
	Command.withDescription(
		tableHelp("table sync", [
			'Fills the table\'s rows from the lane records on its issues; prints {"answer","repo","project",…}.',
			"  7: no table project, or a named number is no issue",
			"  8: a write did not land (UNKNOWN); re-run",
			"  9: the rows do not read back in step",
			"  11: a read failed, or past 2000 issues (UNKNOWN)",
			"  12: the table block does not decode",
			"  20: the token lacks the project scope",
			"  22: two open projects carry the table's title",
			"  23: a field or option is missing; run table setup",
			"  24: a lane record does not read",
		]),
	),
	Command.withExamples([
		{command: "fabrika table sync 9856"},
		{command: "fabrika table sync --dry-run"},
	]),
);

const flags = leafCommand(
	"flags",
	{
		issues: Argument.integer("issue").pipe(
			Argument.withDescription(
				"an issue whose rows to flag; none flags the whole table and asks the table-wide checks",
			),
			Argument.atLeast(0),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issues, repo}) {
		yield* emit(
			yield* runFlags({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				issues,
				now: new Date(),
				board: flagsBoard,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Read what the next table must look at; writes nothing."),
	Command.withDescription(
		tableHelp("table flags", [
			'Names what on the table needs a person, writing nothing; prints {"answer","flags","unread",…}.',
			"  7: no table project, or a named number is no issue",
			"  11: the project, an issue or its comments was unreadable (UNKNOWN)",
			"  12: the table, appetiteSizes or boards block does not decode",
			"  20: the token lacks the project scope",
			"  22: two open projects carry the table's title",
			"  24: a lane record does not read",
		]),
	),
	Command.withExamples([{command: "fabrika table flags"}]),
);

const prep = leafCommand(
	"prep",
	{repo: repoFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({repo, dryRun}) {
		yield* emit(
			yield* runPrep({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				now: new Date(),
				board: prepBoard,
				dryRun,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Fill the next table's agenda, carry bets over, and post its health.",
	),
	Command.withDescription(
		tableHelp("table prep", [
			'Dates the next table\'s rows and posts its health; prints {"answer","tableDay","agenda",…}.',
			"  7: no table or on-call project; run table setup",
			"  8: a write did not land (UNKNOWN)",
			"  9: the rows or the update do not read back",
			"  11: a read failed (UNKNOWN)",
			"  12: a .fabrika.jsonc block does not decode",
			"  20: the token lacks the project scope",
			"  22: two open projects carry the table's title",
			"  23: a field or option is missing; run table setup",
			"  24: a lane record does not read",
		]),
	),
	Command.withExamples([
		{command: "fabrika table prep --dry-run"},
		{command: "fabrika table prep"},
	]),
);

const migrateWeek = leafCommand(
	"migrate-week",
	{repo: repoFlag},
	Effect.fn(function* ({repo}) {
		yield* emit(
			yield* runMigrate({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				board: migrateBoard,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Copy each row's legacy Week start date into Table day, once."),
	Command.withDescription(
		tableHelp("table migrate-week", [
			'Dates each undated row by its Week start, never writing Week; prints {"answer","dated",…}.',
			"  7: no table project",
			"  8: a write did not land (UNKNOWN); re-run",
			"  9: the rows do not read back dated",
			"  11: a read failed (UNKNOWN)",
			"  12: the table block does not decode",
			"  20: the token lacks the project scope",
			"  22: two open projects carry the table's title",
			"  23: no Table day field; run table setup",
		]),
	),
	Command.withExamples([{command: "fabrika table migrate-week"}]),
);

export const tableCommand = Command.make("table").pipe(
	Command.withSubcommands([setup, sync, flags, prep, migrateWeek]),
	Command.withShortDescription("Set up and fill the weekly betting table on GitHub Projects."),
	Command.withDescription(
		"The weekly betting table: a GitHub project per repository where control-plane owners decide what gets bet on. Its verbs need the token's `project` scope. `lane brief`, `lane record`, `build pick` and the pitch guard read the table too; with no `table` block they carry on when that read fails.",
	),
);
