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
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {runAnchor} from "./anchor-verb.ts";
import {runCorpus} from "./corpus-verb.ts";
import {runDrift} from "./drift-verb.ts";
import {runNew} from "./new-verb.ts";
import {runRegister} from "./register-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".patterns"),
	Flag.withDescription("the directory of flat <slug>.md pattern docs (default: .patterns)"),
);

const baseFlag = Flag.string("base").pipe(
	Flag.withDefault("origin/main"),
	Flag.withDescription(
		"the base ref the corpus is read at, fetched before it is read (default: origin/main)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit one JSON object on stdout instead of the line grammar"),
);

const slugArgument = Argument.string("slug").pipe(
	Argument.withDescription("the doc's basename without .md, kebab-case"),
);

const corpus = leafCommand(
	"corpus",
	{dir: dirFlag, base: baseFlag, json: jsonFlag},
	Effect.fn(function* ({dir, base, json}) {
		yield* emit(yield* runCorpus({dir, base, json}));
	}),
).pipe(
	Command.withShortDescription("Every pattern doc at a base ref, with its registration."),
	Command.withDescription(
		'The library at a base ref: every doc, its index registration, its section and its last-touching commit. Prints `corpus <library|none|absent> <docs> <unregistered> <unknown> <dangling>` then one `doc` line per doc and one `dangling` line per index row pointing outside the corpus — all three outcomes at exit 0, because an empty or absent library is a fact a repo adopting fabrika must be able to act on. Exits 11 (the base could not be fetched, or a tree or history read failed — UNKNOWN, never "none"). Example: fabrika pattern corpus --dir .patterns',
	),
);

const drift = leafCommand(
	"drift",
	{slug: slugArgument, dir: dirFlag, base: baseFlag, json: jsonFlag},
	Effect.fn(function* ({slug, dir, base, json}) {
		yield* emit(yield* runDrift({slug, dir, base, json}));
	}),
).pipe(
	Command.withShortDescription("Whether the in-repo source a doc cites has moved."),
	Command.withDescription(
		'Whether the in-repo source a doc cites moved since the doc was last written. Prints `drift <drifted|current|unanchored|unborn> <anchor-sha> <cited> <in-repo> <unresolved> <moved>` then one `path` line per moved path — all four outcomes at exit 0. `unanchored` is not a clearance: it says the doc cites nothing this verb can follow. Exits 11 (a fetch, tree or history read failed — UNKNOWN, never "current"), 12 (no doc for the slug, in the working tree or at the base). Example: fabrika pattern drift worker-queue-retry',
	),
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
		yield* emit(yield* runAnchor({slug, dir, manifest, base, json}));
	}),
).pipe(
	Command.withShortDescription("Whether the dependency version a doc declares still matches."),
	Command.withDescription(
		'Whether the dependency version a doc declares still matches what the workspace pins, compared byte for byte with no semver interpretation. Prints `anchor <matched|moved|malformed|unpinned|unanchored|unborn> <declared> <moved> <unpinned> <malformed>` then one `pkg` line per declaration — every outcome at exit 0. A line that claims an anchor and does not parse is `malformed`, never absent. Exits 11 (the base could not be fetched, or the doc or manifest could not be read — every pin is UNKNOWN, never "unpinned"), 12 (no doc for the slug). Example: fabrika pattern anchor worker-queue-retry',
	),
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
		"Scaffold <dir>/<slug>.md for a current pattern, or a prospective pattern with --decision. Optional --source-repo inspection derives a canonical origin, full HEAD commit, relevant package version and representative source/test/docs paths without serializing the local path; use --source-package when a monorepo is ambiguous. Writes exactly one file. Exits 8 (write UNKNOWN), 13 (target exists), 17 (source evidence refused). Example: fabrika pattern new worker-queue-retry --decision https://github.com/acme/repo/issues/1 --source-repo ../acme --source-package acme-queue",
	),
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
		'Insert the doc\'s row into <dir>/index.md under a named section, proving the edit changed no other line before it writes and reading the row back after. Prints `<inserted|already> <path> <section>`. Exits 8/9 (the write failed, the read-back does not carry the row), 10 (no such section — every section carrying a table is named), 12 (no doc to point the row at), 14 (the edit would have changed a line beyond the new row), 15 (the index is absent or holds no parseable table), 16 (the section name matches more than one heading). Example: fabrika pattern register worker-queue-retry --section "Index — Effect domain layer" --topic "Retry and backoff" --read-when "Adding a queue consumer"',
	),
);

export const patternCommand = Command.make("pattern").pipe(
	Command.withSubcommands([corpus, drift, anchor, create, register]),
	Command.withShortDescription("Read and write the pattern library."),
	Command.withDescription(
		"Read and write the pattern library: the corpus at a base ref, whether a doc's cited source or declared dependency pin moved, and the two writes that scaffold a doc and register its row",
	),
);
