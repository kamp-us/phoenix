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
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {runList} from "./list-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runState} from "./state-verb.ts";

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
	Flag.withDefault(false),
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
		[
			"Prints the ## Campaigns rows as `#<milestone>\\t<state>\\t<name>`, or `none` when no row matches.",
			"  11: the roadmap file could not be read",
			"  12: a data row will not parse",
			"  22: .fabrika.jsonc or its roadmapFile is unreadable",
			'  Derivation: the campaign skill\'s contract.md, "campaign list"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika campaign list --state active"}]),
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
		[
			"Appends a paused campaign row past the approval trace and prints it read back.",
			"  8: the write failed (maybe half-written)",
			"  9: the read-back holds no such row",
			"  11: the roadmap is unreadable",
			"  12: the table is unreadable",
			"  13: authority is UNKNOWN",
			"  14: no marker on the comment",
			"  15: a malformed or misbound marker",
			"  16: author not in campaignAuthors",
			"  17: campaignAuthors is empty",
			"  19: a row already holds this name or milestone",
			"  21: author holds below write",
			"  22: .fabrika.jsonc is unreadable",
			'  Derivation: the campaign skill\'s contract.md, "campaign open"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika campaign open "Mecmua reading layout" --milestone 52 --cites https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<comment-id>',
		},
	]),
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
		[
			"Rewrites one row's State cell past the approval trace and prints the row read back.",
			"  7: the selector matches no row",
			"  8: the write failed (maybe half-written)",
			"  9: the read-back does not hold --to",
			"  11: the roadmap is unreadable",
			"  12: the table is unreadable",
			"  13: authority is UNKNOWN",
			"  14: no marker",
			"  15: a malformed or misbound marker",
			"  16: author not in campaignAuthors",
			"  17: campaignAuthors is empty",
			"  18: several rows match",
			"  20: the row already holds --to",
			"  21: author holds below write",
			"  22: .fabrika.jsonc is unreadable",
			'  Derivation: the campaign skill\'s contract.md, "campaign state"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika campaign state '#<milestone>' --to active --cites https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<comment-id>",
		},
	]),
);

export const campaignCommand = Command.make("campaign").pipe(
	Command.withSubcommands([list, open, state]),
	Command.withShortDescription("Read and write the ## Campaigns table that gates dispatch."),
	Command.withDescription(
		"Read the ## Campaigns table, declare a new campaign paused, and flip one campaign's lifecycle state — each write past a cited founder approval, because that State cell is the permission to open lanes against a milestone",
	),
);
