/**
 * The `campaign` verb group — `fabrika campaign <list|open|state>`, the `campaign` skill's half of
 * the roadmap surface.
 *
 * The adapter and nothing else: it declares the flags, hands the verb the ambient cwd and env, and
 * emits the outcome. Every decision lives in the `*-verb.ts` modules beside it.
 *
 * `--state` and `--to` are declared as strings and checked in the verbs, so a refusal can name the
 * whole closed vocabulary in this group's own words rather than emit the parser's generic message.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runList} from "./list-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runState} from "./state-verb.ts";

const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const fileFlag = Flag.string("file").pipe(
	Flag.optional,
	Flag.withDescription(
		"the roadmap file (default: `roadmapFile` in .fabrika.jsonc, itself defaulting to ROADMAP.md)",
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the repository the cited comment must belong to (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const citesFlag = Flag.string("cites").pipe(
	Flag.withDescription(
		"the comment URL whose first line carries the campaign-approve: marker authorizing this write",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("print one JSON object instead of the row line grammar"),
);

const list = leafCommand(
	"list",
	{
		state: Flag.string("state").pipe(
			Flag.optional,
			Flag.withDescription("print only the rows holding this state: active, paused or done"),
		),
		file: fileFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({state, file, json}) {
		yield* emit(
			yield* runList({
				state: Option.getOrNull(state),
				file: Option.getOrNull(file),
				json,
				cwd: process.cwd(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Print the ## Campaigns rows, optionally narrowed to one state."),
	Command.withDescription(
		'Print the ## Campaigns rows as #<milestone>\\t<state>\\t<name>, in table order. An absent table, an empty one and a --state that matches nothing all print the single line "none" at exit 0 — nothing declared means the dispatch fence is off, not closed. Under --json: {"rows":[{"milestone":47,"state":"active","name":"…"}],"file":"ROADMAP.md"}. Exits 1 (a --state outside the three values), 11 (the roadmap file could not be read), 12 (a data row will not parse — the whole table is unreadable), 22 (.fabrika.jsonc could not be read, or its roadmapFile will not decode). Example: fabrika campaign list --state active',
	),
);

const open = leafCommand(
	"open",
	{
		name: Argument.string("name").pipe(
			Argument.withDescription(
				"the founder-voice campaign name, written verbatim into the row's first cell",
			),
		),
		milestone: Flag.integer("milestone").pipe(
			Flag.withDescription("the GitHub milestone number this campaign pins"),
		),
		cites: citesFlag,
		file: fileFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({name, milestone, cites, file, repo, json}) {
		yield* emit(
			yield* runOpen({
				name,
				milestone,
				cites,
				file: Option.getOrNull(file),
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append a new paused campaign row, past the approval trace."),
	Command.withDescription(
		'Append a new campaign row pinning a milestone, past the campaign-approve: trace, and read it back. The row is always written paused and there is no flag to change that: naming a campaign and granting it dispatch are two acts (ADR 0304), and the second is `campaign state`. Prints the row read back, or under --json {"row":{"milestone":52,"state":"paused","name":"…"},"file":"ROADMAP.md"}. Exits 1 (usage), 8 (the write failed — the table may be half-written), 9 (the read-back holds no row for --milestone), 11 (the roadmap could not be read), 12 (the table is unreadable), 13 (the comment, a team membership, the author\'s permission or the repository could not be resolved — authority is UNKNOWN), 14 (no marker on the comment\'s first line), 15 (the marker is malformed, misbound, or in another repository), 16 (the author is not in campaignAuthors), 17 (campaignAuthors is empty — nobody may declare), 19 (a row already holds this name or pins this milestone), 21 (the author holds below write on the repo), 22 (config). Example: fabrika campaign open "Mecmua reading layout" --milestone 52 --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028',
	),
);

const state = leafCommand(
	"state",
	{
		selector: Argument.string("selector").pipe(
			Argument.withDescription(
				"#<milestone>, or a campaign name matched exactly against the row's first cell",
			),
		),
		to: Flag.string("to").pipe(
			Flag.withDescription("the state to write into the row's third cell: active, paused or done"),
		),
		cites: citesFlag,
		file: fileFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({selector, to, cites, file, repo, json}) {
		yield* emit(
			yield* runState({
				selector,
				to,
				cites,
				file: Option.getOrNull(file),
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Rewrite one campaign row's State cell, past the approval trace."),
	Command.withDescription(
		'Rewrite one campaign row\'s State cell, past the campaign-approve: trace, and read it back. Only the state token moves — the cell is never re-padded, so every other line stays byte-identical. Selection is exact: two matches refuse rather than pick. Prints the row read back, or under --json {"row":{…},"from":"paused","file":"ROADMAP.md"}. Exits 1 (usage), 7 (the selector matches no row), 8 (the write failed — the row may be half-written), 9 (the read-back does not hold --to), 11 (the roadmap could not be read), 12 (the table is unreadable), 13 (authority is UNKNOWN), 14 (no marker), 15 (the marker is malformed, misbound, or in another repository), 16 (the author is not in campaignAuthors), 17 (campaignAuthors is empty), 18 (the selector matches more than one row), 20 (the row already holds --to — nothing written), 21 (the author holds below write), 22 (config). Example: fabrika campaign state \'#42\' --to active --cites https://github.com/kamp-us/phoenix/issues/6289#issuecomment-5337663028',
	),
);

export const campaignCommand = Command.make("campaign").pipe(
	Command.withSubcommands([list, open, state]),
	Command.withShortDescription("Read and write the ## Campaigns table that gates dispatch."),
	Command.withDescription(
		"Read the ## Campaigns table, declare a new campaign paused, and flip one campaign's lifecycle state — each write past a cited founder approval, because that State cell is the permission to open lanes against a milestone (ADR 0304)",
	),
);
