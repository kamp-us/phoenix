/**
 * The `adr` verb group — `fabrika adr <next|new|mint|resolve|supersede|amend-in-part|sweep>`.
 *
 * This file is the adapter and nothing else: it declares the flags (`--help` is the interface, so
 * every flag carries a one-line description), runs the pure verb, and emits its outcome. Every
 * decision the verbs make lives in the `*-verb.ts` modules beside it, which is what makes each
 * refusal testable without spawning a process.
 */
import {Effect, type FileSystem, Option, type Path} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {corpusOverride, decisionsDirOr} from "../config/paths.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {CORPUS_DECLINED, DIR_UNREADABLE} from "./codes.ts";
import {runMint} from "./mint-verb.ts";
import {runNew} from "./new-verb.ts";
import {runNext} from "./next-verb.ts";
import {runRelate} from "./relate-verb.ts";
import {runResolve} from "./resolve-verb.ts";
import {DEFAULT_LIMIT} from "./sweep.ts";
import {runSweep} from "./sweep-verb.ts";

const dirFlag = Flag.string("dir").pipe(
	Flag.optional,
	Flag.withDescription(
		"the directory of NNNN-slug.md decision records to scan (default: `decisionsDir` in .fabrika.jsonc, itself defaulting to .decisions)",
	),
);

/**
 * The corpus every verb of this group runs over: the flag if given, else the repo's declared one.
 *
 * Resolved here rather than inside each verb because the answer is the same question seven times,
 * and both of its bad arms end the run before any verb starts — there is no corpus to point a read
 * or a write at, so reaching the verb would only move the same refusal later.
 */
const corpusFor = (
	verb: string,
	declared: Option.Option<string>,
): Effect.Effect<
	| {readonly _tag: "Dir"; readonly dir: string}
	| {readonly _tag: "Stop"; readonly outcome: VerbOutcome},
	never,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const read = yield* decisionsDirOr(
			verb,
			process.cwd(),
			corpusOverride("--dir", Option.getOrNull(declared)),
			"there is nothing to read and nothing to write into.",
		);
		switch (read._tag) {
			case "Dir":
				return {_tag: "Dir" as const, dir: read.dir};
			case "Declined":
				return {_tag: "Stop" as const, outcome: refuse(CORPUS_DECLINED, read.message)};
			case "Refused":
				return {_tag: "Stop" as const, outcome: refuse(DIR_UNREADABLE, read.message)};
		}
	});

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
		const corpus = yield* corpusFor("adr next", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(yield* runNext({dir: corpus.dir, base, repo: Option.getOrNull(repo), json}));
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

/** The frontmatter flags `adr new` and `adr mint` fill the same template from. */
const templateFlags = {
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
};

const newCmd = leafCommand(
	"new",
	{
		id: idArg,
		slug: slugArg,
		dir: dirFlag,
		...templateFlags,
		json: jsonFlag,
	},
	Effect.fn(function* ({id, slug, dir, status, date, title, tags, json}) {
		const corpus = yield* corpusFor("adr new", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(
			yield* runNew({
				id,
				slug,
				dir: corpus.dir,
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
		"Scaffold .decisions/NNNN-slug.md from the canonical template. Prints the path written. Exits 12 (path exists — never overwritten); a bad id or slug is a usage error and exits 1. Example: fabrika adr new 0240 only-landed-adrs-may-be-cited",
	),
);

const mint = leafCommand(
	"mint",
	{
		slug: slugArg,
		dir: dirFlag,
		base: baseFlag,
		repo: repoFlag,
		...templateFlags,
		json: jsonFlag,
	},
	Effect.fn(function* ({slug, dir, base, repo, status, date, title, tags, json}) {
		const corpus = yield* corpusFor("adr mint", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(
			yield* runMint({
				slug,
				dir: corpus.dir,
				base,
				repo: Option.getOrNull(repo),
				status,
				date: Option.getOrElse(date, today),
				title: Option.getOrNull(title),
				tags: Option.getOrNull(tags),
				json,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Allocate the next ADR id and scaffold its record in one call."),
	Command.withDescription(
		"Allocate the next unused ADR id and scaffold its record in one invocation — `adr next` then `adr new` with no gap for another lane's mint to land in. Prints the path written; --json adds id/mergedMax/inFlight/baseSha. Exits 11 (--dir unreadable), 12 (path exists — never overwritten), 17 (base unfetchable), 18 (in-flight unknown), 19 (a record filename with no readable id), 21 (origin remote unresolvable); a bad slug is a usage error and exits 1. Example: fabrika adr mint only-landed-adrs-may-be-cited",
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
		const corpus = yield* corpusFor("adr resolve", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(
			yield* runResolve({ids, dir: corpus.dir, base, repo: Option.getOrNull(repo), json}),
		);
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
		const corpus = yield* corpusFor("adr supersede", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(yield* runRelate({relationship: "supersede", id, by, dir: corpus.dir, json}));
	}),
).pipe(
	Command.withShortDescription("Mark an older ADR superseded by this one."),
	Command.withDescription(
		"Rewrite an older ADR's status: line to `superseded by [NNNN](NNNN-slug.md)` — that line and nothing else. Prints `<path>\\t<new status>`. Exits 7 (no such id), 13 (no --by record), 14 (no single status: line), 15 (diff touched another line — nothing written), 16 (already superseded). Example: fabrika adr supersede 0126 --by 0240",
	),
);

const amendInPart = leafCommand(
	"amend-in-part",
	{id: idArg, by: byFlag, dir: dirFlag, json: jsonFlag},
	Effect.fn(function* ({id, by, dir, json}) {
		const corpus = yield* corpusFor("adr amend-in-part", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(yield* runRelate({relationship: "amend-in-part", id, by, dir: corpus.dir, json}));
	}),
).pipe(
	Command.withShortDescription("Add this ADR to an older one's amended-in-part list."),
	Command.withDescription(
		"Append this ADR to an older one's `amended-in-part by` list, in id order, preserving the links already there. Prints `<path>\\t<new status>`. Same exit codes as supersede. Example: fabrika adr amend-in-part 0023 --by 0240",
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
		const corpus = yield* corpusFor("adr sweep", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		yield* emit(yield* runSweep({new: subject, dir: corpus.dir, limit, json}));
	}),
).pipe(
	Command.withShortDescription("Rank the live ADRs this one may contradict."),
	Command.withDescription(
		"Rank the uncited live-accepted ADRs this one may contradict. First stdout line is the outcome token — shortlist | no-overlap | indeterminate — and ALL THREE exit 0; a shortlist adds one `<id>\\t<score>\\t<file>\\t<title>` line per entry. An empty-and-readable --dir answers indeterminate. Exits 7 (no readable --new), 11 (corpus unreadable). Example: fabrika adr sweep --new 0240",
	),
);

export const adrCommand = Command.make("adr").pipe(
	Command.withSubcommands([next, newCmd, mint, resolve, supersede, amendInPart, sweepCmd]),
	Command.withShortDescription("Record one architecture decision, from id to citations."),
	Command.withDescription(
		"Record one architecture decision: allocate an id, scaffold the file, sweep for contradictions, resolve citations, and edit the status lines a new decision implies",
	),
);
