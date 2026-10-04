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
import type {ChildProcessSpawner} from "effect/unstable/process";
import {corpusOverride, decisionsDirOr} from "../config/paths.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {baseOrTrunk, TRUNK_DEFAULT_HELP, trunkUnresolved} from "../io/trunk.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {BASE_UNFETCHABLE, CORPUS_DECLINED, DIR_UNREADABLE} from "./codes.ts";
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
	Flag.optional,
	Flag.withDescription(
		`the base ref to fetch and read the merged set from — fetched before it is read (default: ${TRUNK_DEFAULT_HELP})`,
	),
);

/** The `--base` a verb of this group reads at, or the refusal an unresolvable trunk is. */
const baseFor = (
	verb: string,
	named: Option.Option<string>,
	repo: Option.Option<string>,
): Effect.Effect<
	| {readonly _tag: "Base"; readonly base: string}
	| {readonly _tag: "Stop"; readonly outcome: VerbOutcome},
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.map(baseOrTrunk(Option.getOrNull(named), process.env, Option.getOrNull(repo)), (read) =>
		read._tag === "Ok"
			? {_tag: "Base" as const, base: read.value}
			: {
					_tag: "Stop" as const,
					outcome: refuse(
						BASE_UNFETCHABLE,
						`${verb}: ${trunkUnresolved(read.reason)}. Pass --base to name the ref yourself.`,
					),
				},
	);

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the owner/name whose open pull requests form the in-flight set (default: the origin remote's owner/name)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
	Flag.withDescription("emit the answer as JSON on stdout instead of the line grammar"),
);

const today = (): string => new Date().toISOString().slice(0, 10);

const next = leafCommand(
	"next",
	{dir: dirFlag, base: baseFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({dir, base, repo, json}) {
		const corpus = yield* corpusFor("adr next", dir);
		if (corpus._tag === "Stop") return yield* emit(corpus.outcome);
		const at = yield* baseFor("adr next", base, repo);
		if (at._tag === "Stop") return yield* emit(at.outcome);
		yield* emit(
			yield* runNext({dir: corpus.dir, base: at.base, repo: Option.getOrNull(repo), json}),
		);
	}),
).pipe(
	Command.withShortDescription("The next unused ADR id: merged, open-PR and branch claims folded."),
	Command.withDescription(
		[
			"Prints the next unused ADR id, such as `0240`, or `0001` for an empty readable --dir.",
			"  11: --dir unreadable",
			"  17: --base could not be fetched, or no --base and the trunk is unresolvable",
			"  18: the in-flight set is unknown",
			"  19: a record filename has no readable id",
			"  21: the origin remote is unresolvable",
			"  23: the branch refs could not be walked",
			'  Derivation: the adr skill\'s contract.md, "adr next"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr next"}]),
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
		[
			"Scaffolds <dir>/NNNN-slug.md from the canonical template and prints the path written.",
			"  12: the path exists and is never overwritten",
			'  Derivation: the adr skill\'s contract.md, "adr new"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr new 0240 only-landed-adrs-may-be-cited"}]),
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
		const at = yield* baseFor("adr mint", base, repo);
		if (at._tag === "Stop") return yield* emit(at.outcome);
		yield* emit(
			yield* runMint({
				slug,
				dir: corpus.dir,
				base: at.base,
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
		[
			"Allocates the next ADR id, scaffolds its record in the same call and prints the path written.",
			"  11: --dir unreadable",
			"  12: the path exists and is never overwritten",
			"  17: --base could not be fetched, or no --base and the trunk is unresolvable",
			"  18: the in-flight set is unknown",
			"  19: a record filename has no readable id",
			"  21: the origin remote is unresolvable",
			"  23: the branch refs could not be walked",
			'  Derivation: the adr skill\'s contract.md, "adr mint"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr mint only-landed-adrs-may-be-cited"}]),
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
		const at = yield* baseFor("adr resolve", base, repo);
		if (at._tag === "Stop") return yield* emit(at.outcome);
		yield* emit(
			yield* runResolve({ids, dir: corpus.dir, base: at.base, repo: Option.getOrNull(repo), json}),
		);
	}),
).pipe(
	Command.withShortDescription("Resolve ADR ids to their real filename and state at a base ref."),
	Command.withDescription(
		[
			"Prints one `<state>\\t<file>\\t<detail>` line per id, state live|landed|in-flight|absent.",
			"  11: --dir or one of its records is unreadable",
			"  17: --base could not be fetched, or no --base and the trunk is unresolvable",
			"  18: the in-flight set is unknown",
			"  19: a record filename has no readable id",
			"  20: two records carry one id",
			"  21: the origin remote is unresolvable",
			'  Derivation: the adr skill\'s contract.md, "adr resolve"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr resolve 0164 0023"}]),
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
		[
			"Rewrites an older ADR's status line to `superseded by` and prints `<path>\\t<new status>`.",
			"  7: no such id",
			"  13: no --by record",
			"  14: no single status line",
			"  15: the diff touched another line, so nothing was written",
			"  16: already superseded",
			'  Derivation: the adr skill\'s contract.md, "adr supersede and adr amend-in-part"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr supersede 0126 --by 0240"}]),
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
		[
			"Adds this ADR to an older one's `amended-in-part by` list and prints `<path>\\t<new status>`.",
			"  7: no such id",
			"  13: no --by record",
			"  14: no single status line",
			"  15: the diff touched another line, so nothing was written",
			"  16: the record is superseded, so it is not amendable",
			'  Derivation: the adr skill\'s contract.md, "adr supersede and adr amend-in-part"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr amend-in-part 0023 --by 0240"}]),
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
		[
			"Prints shortlist, no-overlap or indeterminate, each an answer, then one line per shortlisted ADR.",
			"  7: no readable --new",
			"  11: the corpus is unreadable",
			'  Derivation: the adr skill\'s contract.md, "adr sweep"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika adr sweep --new 0240"}]),
);

export const adrCommand = Command.make("adr").pipe(
	Command.withSubcommands([next, newCmd, mint, resolve, supersede, amendInPart, sweepCmd]),
	Command.withShortDescription("Record one architecture decision, from id to citations."),
	Command.withDescription(
		"Record one architecture decision: allocate an id, scaffold the file, sweep for contradictions, resolve citations, and edit the status lines a new decision implies",
	),
);
