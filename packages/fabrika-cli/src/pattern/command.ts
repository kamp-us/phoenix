/**
 * The `pattern` verb group — `fabrika pattern <corpus|drift|anchor|new|register>`, the
 * `write-pattern` skill's mechanical half.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {baseOrTrunk, TRUNK_DEFAULT_HELP, trunkUnresolved} from "../io/trunk.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {runAnchor} from "./anchor-verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runCorpus} from "./corpus-verb.ts";
import {runDrift} from "./drift-verb.ts";
import {runNew} from "./new-verb.ts";
import {runRegister} from "./register-verb.ts";

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".patterns"),
	Flag.withDescription("the directory of flat <slug>.md pattern docs (default: .patterns)"),
);

const baseFlag = Flag.string("base").pipe(
	Flag.optional,
	Flag.withDescription(
		`the base ref the corpus is read at, fetched before it is read (default: ${TRUNK_DEFAULT_HELP})`,
	),
);

/**
 * Run `verb` at the `--base` the operator named, else at the trunk; an unresolvable trunk is the
 * group's UNKNOWN, never a read at a spelled branch.
 */
const atBase = <R>(
	verb: string,
	named: Option.Option<string>,
	run: (base: string) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R | ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.flatMap(baseOrTrunk(Option.getOrNull(named), process.env, null), (read) =>
		read._tag === "Ok"
			? run(read.value)
			: Effect.succeed(
					refuse(
						PRECONDITION_UNKNOWN,
						`${verb}: ${trunkUnresolved(read.reason)}. Pass --base to name the ref yourself.`,
					),
				),
	);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
	Flag.withDescription("emit one JSON object on stdout instead of the line grammar"),
);

const slugArgument = Argument.string("slug").pipe(
	Argument.withDescription("the doc's basename without .md, kebab-case"),
);

const corpus = leafCommand(
	"corpus",
	{dir: dirFlag, base: baseFlag, json: jsonFlag},
	Effect.fn(function* ({dir, base, json}) {
		yield* emit(yield* atBase("pattern corpus", base, (at) => runCorpus({dir, base: at, json})));
	}),
).pipe(
	Command.withShortDescription("Every pattern doc at a base ref, with its registration."),
	Command.withDescription(
		[
			"Prints the pattern library at a base ref: a `corpus` line, then one line per doc and dangling row.",
			"  library, none and absent are all answers.",
			"  11: the base fetch or a tree or history read failed (UNKNOWN)",
			'  Derivation: the write-pattern skill\'s contract.md, "pattern corpus"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika pattern corpus --dir .patterns"}]),
);

const drift = leafCommand(
	"drift",
	{slug: slugArgument, dir: dirFlag, base: baseFlag, json: jsonFlag},
	Effect.fn(function* ({slug, dir, base, json}) {
		yield* emit(
			yield* atBase("pattern drift", base, (at) => runDrift({slug, dir, base: at, json})),
		);
	}),
).pipe(
	Command.withShortDescription("Whether the in-repo source a doc cites has moved."),
	Command.withDescription(
		[
			"Prints whether the source a doc cites moved since it was written, then one line per moved path.",
			"  Every outcome is an answer, and `unanchored` is not a clearance.",
			"  11: a fetch, tree or history read failed (UNKNOWN)",
			"  12: no doc for the slug",
			'  Derivation: the write-pattern skill\'s contract.md, "pattern drift"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika pattern drift worker-queue-retry"}]),
);

const anchor = leafCommand(
	"anchor",
	{
		slug: slugArgument,
		dir: dirFlag,
		manifest: Flag.string("manifest").pipe(
			Flag.withDefault("pnpm-workspace.yaml"),
			Flag.withDescription(
				"the workspace manifest whose catalog: map holds the live pins (default: pnpm-workspace.yaml)",
			),
		),
		base: baseFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({slug, dir, manifest, base, json}) {
		yield* emit(
			yield* atBase("pattern anchor", base, (at) =>
				runAnchor({slug, dir, manifest, base: at, json}),
			),
		);
	}),
).pipe(
	Command.withShortDescription("Whether the dependency version a doc declares still matches."),
	Command.withDescription(
		[
			"Prints whether a doc's declared dependency versions match the workspace pins, then one line each.",
			"  Every outcome is an answer, and an unparseable anchor line is `malformed`, never absent.",
			"  11: a fetch or read failed, or a declared dependency has conflicting pins",
			"  12: no doc for the slug",
			'  Derivation: the write-pattern skill\'s contract.md, "pattern anchor"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika pattern anchor worker-queue-retry"}]),
);

const create = leafCommand(
	"new",
	{
		slug: slugArgument,
		dir: dirFlag,
		title: Flag.string("title").pipe(
			Flag.optional,
			Flag.withDescription(
				"the H1 text (default: the slug with hyphens as spaces and the first character upper-cased)",
			),
		),
		anchor: Flag.string("anchor").pipe(
			Flag.optional,
			Flag.withDescription(
				"a <pkg>@<version> this doc is derived from; adds the anchor line pattern anchor reads",
			),
		),
		decision: Flag.string("decision").pipe(
			Flag.optional,
			Flag.withDescription(
				"the binding-decision citation for a prospective pattern; selects the prospective scaffold",
			),
		),
		sourceRepo: Flag.string("source-repo").pipe(
			Flag.optional,
			Flag.withDescription(
				"a local authoritative Git checkout to inspect before writing; its path is never serialized",
			),
		),
		sourcePackage: Flag.string("source-package").pipe(
			Flag.optional,
			Flag.withDescription(
				"the relevant package name in --source-repo; required when package selection is ambiguous",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({
		slug,
		dir,
		title,
		anchor: anchorToken,
		decision,
		sourceRepo,
		sourcePackage,
		json,
	}) {
		yield* emit(
			yield* runNew({
				slug,
				dir,
				title: Option.getOrNull(title),
				anchor: Option.getOrNull(anchorToken),
				decision: Option.getOrNull(decision),
				sourceRepo: Option.getOrNull(sourceRepo),
				sourcePackage: Option.getOrNull(sourcePackage),
				json,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Scaffold a new pattern doc from the canonical template."),
	Command.withDescription(
		[
			"Scaffolds exactly one <dir>/<slug>.md, current or prospective, from the canonical template.",
			"  8: the write is UNKNOWN",
			"  13: the target exists",
			"  17: the source evidence was refused",
			'  Derivation: the write-pattern skill\'s contract.md, "pattern new"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika pattern new worker-queue-retry --decision https://forge.example/acme/repo/issues/1 --source-repo ../acme --source-package acme-queue",
		},
	]),
);

const register = leafCommand(
	"register",
	{
		slug: slugArgument,
		section: Flag.string("section").pipe(
			Flag.withDescription(
				"the exact heading text, without leading #, of the index section the row goes under",
			),
		),
		topic: Flag.string("topic").pipe(
			Flag.withDescription("the row's second cell: what the doc covers"),
		),
		readWhen: Flag.string("read-when").pipe(
			Flag.withDescription("the row's third cell: when a reader should open it"),
		),
		dir: dirFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({slug, section, topic, readWhen, dir, json}) {
		yield* emit(yield* runRegister({slug, section, topic, readWhen, dir, json}));
	}),
).pipe(
	Command.withShortDescription("Insert the doc's row into the index under a named section."),
	Command.withDescription(
		[
			"Inserts a doc's index row under a section and prints `<inserted|already> <path> <section>`.",
			"  8: the write failed",
			"  9: the read-back does not carry the row",
			"  10: no such section; every section with a table is named",
			"  12: no doc to point the row at",
			"  14: the edit would change a line beyond the new row",
			"  15: the index is absent or holds no parseable table",
			"  16: the section name matches more than one heading",
			'  Derivation: the write-pattern skill\'s contract.md, "pattern register"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika pattern register worker-queue-retry --section "Index — Effect domain layer" --topic "Retry and backoff" --read-when "Adding a queue consumer"',
		},
	]),
);

export const patternCommand = Command.make("pattern").pipe(
	Command.withSubcommands([corpus, drift, anchor, create, register]),
	Command.withShortDescription("Read and write the pattern library."),
	Command.withDescription(
		"Read and write the pattern library: the corpus at a base ref, whether a doc's cited source or declared dependency pin moved, and the two writes that scaffold a doc and register its row",
	),
);
