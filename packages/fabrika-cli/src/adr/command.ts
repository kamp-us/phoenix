/**
 * The `adr` verb group — `fabrika adr <next|new|resolve|supersede|amend-in-part|sweep>`.
 *
 * This file is the adapter and nothing else: it declares the flags (`--help` is the interface, so
 * every flag carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision the verbs make lives in the `*-verb.ts` modules beside it, which is what makes each
 * refusal testable without spawning a process.
 */
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runNew} from "./new-verb.ts";
import {runNext} from "./next-verb.ts";
import {runRelate} from "./relate-verb.ts";
import {runResolve} from "./resolve-verb.ts";
import {DEFAULT_LIMIT} from "./sweep.ts";
import {runSweep} from "./sweep-verb.ts";

/**
 * Write the outcome and exit on its code.
 *
 * stdout carries the answer and nothing else; the scope line and every refusal go to stderr. The
 * exit is explicit even for 0 so the code a verb computed is the code the process returns, never
 * whatever the runtime would have inferred.
 */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".decisions"),
	Flag.withDescription(
		"the directory of NNNN-slug.md decision records to scan (default: .decisions)",
	),
);

const baseFlag = Flag.string("base").pipe(
	Flag.withDefault("origin/main"),
	Flag.withDescription(
		"the base ref to fetch and read the merged set from — fetched before it is read (default: origin/main)",
	),
);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the owner/name whose open pull requests form the in-flight set (default: the origin remote's owner/name)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the answer as JSON on stdout instead of the line grammar"),
);

const today = (): string => new Date().toISOString().slice(0, 10);

const next = leafCommand(
	"next",
	{dir: dirFlag, base: baseFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({dir, base, repo, json}) {
		yield* emit(yield* runNext({dir, base, repo: Option.getOrNull(repo), json}));
	}),
).pipe(
	Command.withShortDescription("The next unused ADR id, merged set and open-PR claims folded."),
	Command.withDescription(
		"The next unused ADR id — max(fetched merged set ∪ open-PR claims) + 1. Prints `0240`; --json adds mergedMax/inFlight/baseSha. An empty-and-readable --dir is a fresh corpus and answers 0001. Exits 11 (--dir unreadable), 17 (base unfetchable), 18 (in-flight unknown), 19 (a record filename with no readable id), 21 (origin remote unresolvable). Example: fabrika adr next",
	),
);

const idArg = Argument.string("id").pipe(
	Argument.withDescription("the four-digit zero-padded id this ADR claims"),
);

const slugArg = Argument.string("slug").pipe(
	Argument.withDescription("the kebab-case slug, at most 5 words"),
);

const newCmd = leafCommand(
	"new",
	{
		id: idArg,
		slug: slugArg,
		dir: dirFlag,
		status: Flag.string("status").pipe(
			Flag.withDefault("accepted"),
			Flag.withDescription("the frontmatter status: value (default: accepted)"),
		),
		date: Flag.string("date").pipe(
			Flag.optional,
			Flag.withDescription("the frontmatter date: value as YYYY-MM-DD (default: today)"),
		),
		title: Flag.string("title").pipe(
			Flag.optional,
			Flag.withDescription(
				"the frontmatter title: value and the H1 (default: the slug, de-hyphenated)",
			),
		),
		tags: Flag.string("tags").pipe(
			Flag.optional,
			Flag.withDescription("comma-separated frontmatter tags (default: empty)"),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({id, slug, dir, status, date, title, tags, json}) {
		yield* emit(
			yield* runNew({
				id,
				slug,
				dir,
				status,
				date: Option.getOrElse(date, today),
				title: Option.getOrNull(title),
				tags: Option.getOrNull(tags),
				json,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Scaffold a new ADR file from the canonical template."),
	Command.withDescription(
		"Scaffold .decisions/NNNN-slug.md from the canonical template. Prints the path written. Exits 12 (path exists — never overwritten); a bad id or slug is a usage error and exits 1. Example: fabrika adr new 0940 only-landed-adrs-may-be-cited",
	),
);

const resolve = leafCommand(
	"resolve",
	{
		ids: idArg.pipe(Argument.atLeast(1)),
		dir: dirFlag,
		base: baseFlag,
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({ids, dir, base, repo, json}) {
		yield* emit(yield* runResolve({ids, dir, base, repo: Option.getOrNull(repo), json}));
	}),
).pipe(
	Command.withShortDescription("Resolve ADR ids to their real filename and state at a base ref."),
	Command.withDescription(
		"Resolve ids to their real filename and state against a fetched base ref — one `<state>\\t<file>\\t<detail>` line per id, state ∈ live|landed|in-flight|absent. An empty-and-readable --dir answers absent. Exits 11 (--dir or one of its records unreadable), 17 (base unfetchable), 18 (in-flight unknown), 19 (a record filename with no readable id), 20 (two records for one id), 21 (origin remote unresolvable). Example: fabrika adr resolve 0164 0023",
	),
);

const byFlag = Flag.string("by").pipe(
	Flag.withDescription("the four-digit id of the ADR doing the superseding or amending"),
);

const supersede = leafCommand(
	"supersede",
	{id: idArg, by: byFlag, dir: dirFlag, json: jsonFlag},
	Effect.fn(function* ({id, by, dir, json}) {
		yield* emit(yield* runRelate({relationship: "supersede", id, by, dir, json}));
	}),
).pipe(
	Command.withShortDescription("Mark an older ADR superseded by this one."),
	Command.withDescription(
		"Rewrite an older ADR's status: line to `superseded by [NNNN](NNNN-slug.md)` — that line and nothing else. Prints `<path>\\t<new status>`. Exits 7 (no such id), 13 (no --by record), 14 (no single status: line), 15 (diff touched another line — nothing written), 16 (already superseded). Example: fabrika adr supersede 0126 --by 0940",
	),
);

const amendInPart = leafCommand(
	"amend-in-part",
	{id: idArg, by: byFlag, dir: dirFlag, json: jsonFlag},
	Effect.fn(function* ({id, by, dir, json}) {
		yield* emit(yield* runRelate({relationship: "amend-in-part", id, by, dir, json}));
	}),
).pipe(
	Command.withShortDescription("Add this ADR to an older one's amended-in-part list."),
	Command.withDescription(
		"Append this ADR to an older one's `amended-in-part by` list, in id order, preserving the links already there. Prints `<path>\\t<new status>`. Same exit codes as supersede. Example: fabrika adr amend-in-part 0023 --by 0940",
	),
);

const sweepCmd = leafCommand(
	"sweep",
	{
		new: Flag.string("new").pipe(
			Flag.withDescription(
				"the ADR to sweep: a four-digit id already in --dir, or a path to the draft file",
			),
		),
		dir: dirFlag,
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(DEFAULT_LIMIT),
			Flag.withDescription(`how many shortlist entries to emit (default: ${DEFAULT_LIMIT})`),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({new: subject, dir, limit, json}) {
		yield* emit(yield* runSweep({new: subject, dir, limit, json}));
	}),
).pipe(
	Command.withShortDescription("Rank the live ADRs this one may contradict."),
	Command.withDescription(
		"Rank the uncited live-accepted ADRs this one may contradict. First stdout line is the outcome token — shortlist | no-overlap | indeterminate — and ALL THREE exit 0; a shortlist adds one `<id>\\t<score>\\t<file>\\t<title>` line per entry. An empty-and-readable --dir answers indeterminate. Exits 7 (no readable --new), 11 (corpus unreadable). Example: fabrika adr sweep --new 0940",
	),
);

export const adrCommand = Command.make("adr").pipe(
	Command.withSubcommands([next, newCmd, resolve, supersede, amendInPart, sweepCmd]),
	Command.withDescription(
		"Record one architecture decision: allocate an id, scaffold the file, sweep for contradictions, resolve citations, and edit the status lines a new decision implies",
	),
);
