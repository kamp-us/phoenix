/**
 * The `table` verb group — `fabrika table <setup>`.
 *
 * The adapter and nothing else: flags, the pure verb, and its emitted outcome. Every leaf is a
 * `leafCommand`, never a bare `Command.make`, so the excess-operand guard covers it.
 */

import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {runSetup} from "./setup-verb.ts";

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
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Create or reconcile the repository's betting table project."),
	Command.withDescription(
		'Create or reconcile the repository\'s betting table on GitHub Projects (v2). With no `table` block in .fabrika.jsonc it finds the open project titled "<repo name> table" linked to the repository, else under the repository\'s owner (and links it), else creates one under the owner and links it; `table.project.owner` / `table.project.number` point it at another. It then adds whatever the table lacks: the fields Stage, Section, Size, Spent $, Asks, Origin, Rec and In plain words, the Week iteration field, the views Agenda, Outside the bets, Lanes, Group members and Inbox (filter `is:open no:label`) with their filters and visible fields, and the README explaining the table and every column. It never deletes or renames anything, never rewrites an existing field\'s options, and reports such drift instead. Idempotent: a project already in shape answers "unchanged" with nothing written. Prints {"answer":"created"|"reconciled"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"changes":[…],"drift":[…],"manualSteps":[…]}; stderr repeats the two manual steps GitHub\'s API cannot take — set the Agenda view\'s grouping to Section and the Lanes board\'s columns to Stage, and turn on the "Auto-add to project" workflow with filter `is:issue is:open no:label` — which the README\'s one-time setup section also lists. The token needs the `project` scope. Exits 1 (usage), 7 (`table.project.number` names no project under its owner), 8 (a write did not land — UNKNOWN; re-run to finish), 9 (the project does not read back as the table after the writes), 11 (the repository or project could not be read — UNKNOWN), 12 (the `table` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 21 (a field the table needs exists under its name with another type; nothing was changed for it), 22 (two open projects linked to the repository, or two under its owner, carry the table\'s title — set `table.project.number`). Example: fabrika table setup',
	),
);

export const tableCommand = Command.make("table").pipe(
	Command.withSubcommands([setup]),
	Command.withShortDescription("Set up the weekly betting table on GitHub Projects."),
	Command.withDescription(
		"The weekly betting table: a GitHub project per repository where control-plane owners decide what gets bet on. Only this group touches Projects, so only its verbs need the token's `project` scope.",
	),
);
