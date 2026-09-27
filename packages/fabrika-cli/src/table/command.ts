/**
 * The `table` verb group — `fabrika table <setup|sync>`.
 *
 * The adapter and nothing else: flags, the pure verb, and its emitted outcome. Every leaf is a
 * `leafCommand`, never a bare `Command.make`, so the excess-operand guard covers it.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {runSetup} from "./setup-verb.ts";
import {runSync, syncBoard} from "./sync-verb.ts";

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
		'Create or reconcile the repository\'s betting table on GitHub Projects (v2). With no `table` block in .fabrika.jsonc it finds the open project titled "<repo name> table" linked to the repository, else under the repository\'s owner (and links it), else creates one under the owner and links it; `table.project.owner` / `table.project.number` point it at another. It then adds whatever the table lacks: the fields Stage, Section, Size, Spent $, Asks, Origin, Rec and In plain words, the Week iteration field, the views Agenda, Outside the bets, Lanes, Group members and Inbox (filter `is:open no:label`) with their filters and visible fields, and the README explaining the table and every column. It never deletes or renames anything, never rewrites an existing field\'s options, and reports as drift instead an option a field lacks or one whose description differs from the table\'s — so a changed `appetiteSizes` rewrites the README and names each stale Size option for a person to edit. Idempotent: a project already in shape answers "unchanged" with nothing written. Prints {"answer":"created"|"reconciled"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"changes":[…],"drift":[…],"manualSteps":[…]}; stderr repeats the two manual steps GitHub\'s API cannot take — set the Agenda view\'s grouping to Section and the Lanes board\'s columns to Stage, and turn on the "Auto-add to project" workflow with filter `is:issue is:open no:label` — which the README\'s one-time setup section also lists. The token needs the `project` scope. Exits 1 (usage), 7 (`table.project.number` names no project under its owner), 8 (a write did not land — UNKNOWN; re-run to finish), 9 (the project does not read back as the table after the writes), 11 (the repository or project could not be read — UNKNOWN), 12 (the `table` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 21 (a field the table needs exists under its name with another type; nothing was changed for it), 22 (two open projects linked to the repository, or two under its owner, carry the table\'s title — set `table.project.number`). Example: fabrika table setup',
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
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
	},
	Effect.fn(function* ({issues, repo}) {
		yield* emit(
			yield* runSync({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				issues,
				board: syncBoard,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Fill the table's columns from the lane records on its issues."),
	Command.withDescription(
		'Join the `lane-record` comments on the named issues (none: every issue already on the table) to the table project, which `table setup` must have made — sync never creates or links one. It walks up from each issue to the rows that sum it (the epic it hangs under, what it blocks) and down to each group row\'s members: an epic row stands for its open sub-issues, a chain row for its open `blocked_by` issues followed transitively, both read off the native graph each run. An open issue with no row gets one — always a real issue item, never a draft, and never a closed issue. Per row it writes Stage `in lane`, or `shipped` once a pull request its records name has merged, but only over an unset, `proposed`, `in lane` or `shipped` Stage: `bet`, `not now` and `check` are never overwritten. It writes Origin from the latest record; Spent $ and Asks summed over each lane\'s latest record — a group head sums itself and its members, and a `bet` row counts only lanes ending at or after the moment its Stage became `bet`, starting at 0; Spent $ is left unwritten while any counted lane is unmeasured. A group head with no Section, no `bet` Stage and at least one lane gets Section "Outside the bets"; a member\'s Section is cleared. Idempotent: a second run answers "unchanged" with nothing written. `lane record` runs it for the lane\'s issue after posting. Prints {"answer":"synced"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"issues":[n…],"groups":[{"head":n,"kind":"epic"|"chain","members":[n…]}],"changes":[…],"skipped":[{"issue":n,"reason":"…"}]}. The token needs the `project` scope. Exits 1 (usage), 7 (no table project — run `table setup` — or a named number is no issue), 8 (a write did not land — UNKNOWN; re-run to finish), 9 (the rows do not read in step after the writes), 11 (the project, an issue, its comments or a pull request could not be read — UNKNOWN; also past 2000 issues in one run), 12 (the `table` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 22 (two open projects carry the table\'s title — set `table.project.number`), 23 (the project lacks a field or option sync writes — run `table setup`), 24 (an issue carries a lane record that does not read). Example: fabrika table sync 9856',
	),
);

export const tableCommand = Command.make("table").pipe(
	Command.withSubcommands([setup, sync]),
	Command.withShortDescription("Set up and fill the weekly betting table on GitHub Projects."),
	Command.withDescription(
		"The weekly betting table: a GitHub project per repository where control-plane owners decide what gets bet on. Only this group touches Projects, so only its verbs need the token's `project` scope.",
	),
);
