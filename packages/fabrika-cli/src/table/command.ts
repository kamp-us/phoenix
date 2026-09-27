/**
 * The `table` verb group — `fabrika table <setup|sync|flags|prep>`.
 *
 * The adapter and nothing else: flags, the pure verb, and its emitted outcome. Every leaf is a
 * `leafCommand`, never a bare `Command.make`, so the excess-operand guard covers it.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {flagsBoard, runFlags} from "./flags-verb.ts";
import {prepBoard, runPrep} from "./prep-verb.ts";
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
		'Create or reconcile the repository\'s betting table on GitHub Projects (v2). With no `table` block in .fabrika.jsonc it finds the open project titled "<repo name> table" linked to the repository, else under the repository\'s owner (and links it), else creates one under the owner and links it; `table.project.owner` / `table.project.number` point it at another. It then adds whatever the table lacks: the fields Stage, Section, Size, Spent $, Asks, Origin, Rec, In plain words and Outcome (worked, didn\'t, can\'t tell — a person\'s answer to a check), the Week iteration field, the views Agenda, Outside the bets, Lanes, Group members and Inbox (filter `is:open no:label`) with their filters and visible fields, and the README explaining the table and every column. It never deletes or renames anything, never rewrites an existing field\'s options, and reports as drift instead an option a field lacks or one whose description differs from the table\'s — so a changed `appetiteSizes` rewrites the README and names each stale Size option for a person to edit. Idempotent: a project already in shape answers "unchanged" with nothing written. Prints {"answer":"created"|"reconciled"|"unchanged","repo":"…","project":{"number":n,"title":"…","url":"…"},"changes":[…],"drift":[…],"manualSteps":[…]}; stderr repeats the two manual steps GitHub\'s API cannot take — set the Agenda view\'s grouping to Section and the Lanes board\'s columns to Stage, and turn on the "Auto-add to project" workflow with filter `is:issue is:open no:label` — which the README\'s one-time setup section also lists. The token needs the `project` scope. Exits 1 (usage), 7 (`table.project.number` names no project under its owner), 8 (a write did not land — UNKNOWN; re-run to finish), 9 (the project does not read back as the table after the writes), 11 (the repository or project could not be read — UNKNOWN), 12 (the `table` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 21 (a field the table needs exists under its name with another type; nothing was changed for it), 22 (two open projects linked to the repository, or two under its owner, carry the table\'s title — set `table.project.number`). Example: fabrika table setup',
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
		'Read the table and name what needs a person, each flag with a one-line rec. Read-only: it writes no field and reverts no value. Per group row, judged once on the head over the sums of the head and every member (the same sums `table sync` writes, and a `bet` row counts only lanes ending at or after it became `bet`), and only while the head or a member is `bet` or `in lane`: over-size, when Spent $ passes the Size\'s `appetiteSizes` dollars (an epic row\'s size counts once per sub-issue) — the lane keeps going, and the flag reads `stopped` at `table.stopMultiple` times the size, where `lane brief` stops the lane (exit 71, park cause size-stop); asks, at `table.asksFlag` asks or more whatever the size; stuck, when nothing happened on any of the group\'s issues (a lane record ending, or the Stage being set) for `table.stuckDays` days, naming the wait or park it knows of, and never while a lane record declares a wait (`lane wait`) until a date still to come. Per `bet` row: unknown-decider, when the account that set Stage `bet` is not in the control-plane set `.github/CODEOWNERS` names — the bet stands as set. With no issue named it also asks two table-wide checks: campaigns, when ROADMAP\'s `## Campaigns` table has more `active` rows than `table.activeCampaignFlag`; and fabrika-share, when lanes on issues carrying a `table.fabrikaShare.labels` label took more of the current Week iteration\'s spend than `table.fabrikaShare.percent` for the first `forTables` tables, then `thenPercent`. A check it could not answer — a lane unmeasured, a set or roadmap that would not read, no label declared, no current iteration — is named under `unread`, never passed. Prints {"answer":"flagged"|"clear","repo":"…","project":{"number":n,"title":"…","url":"…"},"scope":"table"|"issues","rows":[n…],"flags":[{"flag":"over-size"|"asks"|"stuck"|"unknown-decider"|"campaigns"|"fabrika-share",…,"rec":"…"}],"unread":[{"check":"…","issue":n|null,"reason":"…"}]}; row flags carry "head", "group" ("epic"|"chain"|null) and "covers". The token needs the `project` scope. Exits 1 (usage), 7 (no table project — run `table setup` — or a named number is no issue), 11 (the project, an issue or its comments could not be read — UNKNOWN), 12 (the `table` or `appetiteSizes` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 22 (two open projects carry the table\'s title — set `table.project.number`), 24 (an issue carries a lane record that does not read). Example: fabrika table flags',
	),
);

const prep = leafCommand(
	"prep",
	{repo: repoFlag},
	Effect.fn(function* ({repo}) {
		yield* emit(
			yield* runPrep({
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				now: new Date(),
				board: prepBoard,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Fill the next table's agenda, carry running bets over, and post the week's health.",
	),
	Command.withDescription(
		'Run before each table. It prepares the Week iteration the next table day (`table.day`) falls in, which must already exist: add the coming weeks under the Week field in the project\'s settings, because GitHub\'s API adds an iteration only by rewriting the whole list, which empties every row\'s Week. Agenda: it proposes up to `table.agendaCap` rows (25 by default) in `table.sections` order, each a real, open issue, never a draft — Tails (running bets with a `table flags` row flag, then open sub-issues of closed epics), Customers (issues filed by someone whose `author_association` is not OWNER, MEMBER or COLLABORATOR, and only once triaged), New bets (`type:epic` issues with a pitch). A row already `bet`, `not now`, `in lane`, `shipped` or `check` is never proposed again, except a flagged running bet, which moves to Tails with its Stage and Size untouched. Each proposed row gets Stage `proposed`, its Section, the Week, a Size (only when unset: an epic is L, otherwise the smallest size covering its issues\' pitch sizes, an unpitched issue counting as S), a Rec and an In plain words line — the issue\'s `## In plain words` summary, else its title. A candidate with open `blocked_by` issues is one chain row over them (followed transitively), and an epic one row over its open sub-issues: the row counts once toward the cap, its Size and Rec cover every issue in it, its members are added as rows with no Section so they show only in the Group members view, and a chosen row a later chain covers moves inside it. A row where any issue carries `ready-for:human` gets the Rec "needs your pick" with the options the issue lists (under an Options heading, or as "Option A: …" lines), never "yes". An untriaged Customers report (`status:needs-triage` or no label) is never proposed: it is listed under `triageFirst` for the driver to triage and proposed on the next run, and one on `status:needs-info` is listed there marked waiting on filer. Rollover: every other open `bet` row moves to the Week with its Rec cleared, so it continues without an agenda row. A `proposed` row whose issue has closed is taken off the project. Checks: a bet — a row whose Origin reads `bet` — whose Stage has read `shipped` for `table.checkDelayDays` days (14 by default, timed from the Stage value\'s last change) moves to Stage `check` under the first agenda section, in the Week, with a Rec asking "did it work?" and an In plain words line, whatever its issue\'s state, and outside the agenda cap; a shipped row whose Origin is anything else, such as an Outside the bets row sync moved to `shipped`, keeps its Stage and Section and gets no comment. Its evidence is posted once as a comment on the issue: the pitch\'s `**Success:**` line or a note that it has none; the GitHub signals since it shipped — issues filed since that mention a pull request its lane records name, revert pull requests referencing one, its issues reopened since, and its open sub-issues; fabrika\'s land rate and spend per lane in the delay before it shipped against since, when the issue carries a `table.fabrikaShare.labels` label; and the standard output of each `table.evidenceSources` command, run as an argv in the repository root with PATH, HOME, LANG, LC_ALL, TZ and TMPDIR plus FABRIKA_CHECK_REPO, FABRIKA_CHECK_ISSUE, FABRIKA_CHECK_PRS and FABRIKA_CHECK_SHIPPED_AT, stopped at its `timeoutSeconds` and cut at 4000 bytes. A source that exits non-zero, times out or cannot start is reported on the check and on stderr, and prep goes on. A person answers on the Outcome field; prep never writes it and never re-asks a `check` row. Health: it then posts one project status update — land rate, stale lanes, spend and the share of lanes that needed a founder over the week before the iteration, the Outside the bets tally (running un-bet lanes, their origins and cost), the bets continuing, and the Inbox count (open issues with no labels) — `AT_RISK` while a row flag stands, else `ON_TRACK`. The update names its iteration; once it stands, a re-run adds no row, carries nothing and posts nothing, and only takes closed `proposed` rows off. The Agenda view shows this Week\'s rows with a Section and a Rec, open or closed so a check shows, so run `table setup` once to align its filter. Prints {"answer":"prepped"|"unchanged","repo":"…","project":{…},"iteration":{"id":"…","title":"…","startDate":"…"},"agenda":[{"issue":n,"section":"…","kind":"epic"|"chain"|null,"members":[n…],"size":"…","rec":"…","plainWords":"…"}],"overflow":[n…],"rollover":{"continuing":[n…],"flagged":[n…]},"removed":[n…],"checks":[{"issue":n,"shippedAt":"…","success":"…"|null,"signals":{"prs":[n…],"mentions":[…],"reverts":[…],"reopened":[n…],"followUps":[n…]},"fabrika":{…}|null,"sources":[…],"rec":"…","comment":"posted"|"standing"}],"triageFirst":[{"issue":n,"waitingOnFiler":bool}],"outside":{"count":n,"kinds":{…},"spentUsd":n,"unmeasured":n},"health":{"posted":bool,"alreadyPosted":bool,…},"changes":[…]}. The token needs the `project` scope. Exits 1 (usage), 7 (no table project — run `table setup`), 8 (a write, a check comment or the status update did not land — UNKNOWN; re-run to finish), 9 (the rows or the update do not read back after the writes), 11 (the project, the open issues, an issue, its comments, edges or timeline could not be read — UNKNOWN), 12 (the `table` or `appetiteSizes` block in .fabrika.jsonc does not decode), 20 (the token lacks the `project` scope — run `gh auth refresh -h github.com -s project`), 22 (two open projects carry the table\'s title — set `table.project.number`), 23 (the project lacks a field or option prep writes — run `table setup`), 24 (an issue carries a lane record that does not read), 25 (no Week iteration covers the next table day — add the coming weeks in the project\'s settings). Example: fabrika table prep',
	),
);

export const tableCommand = Command.make("table").pipe(
	Command.withSubcommands([setup, sync, flags, prep]),
	Command.withShortDescription("Set up and fill the weekly betting table on GitHub Projects."),
	Command.withDescription(
		"The weekly betting table: a GitHub project per repository where control-plane owners decide what gets bet on. Only this group touches Projects, so only its verbs need the token's `project` scope.",
	),
);
