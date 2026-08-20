/**
 * The `glossary` verb group — `fabrika glossary <init|drift|lookup|sections|add|check>`, the
 * `glossary` skill's half of register maintenance.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), reads the one machine fact this group does not derive — the
 * process's working directory — runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **`--register` is declared as a string and checked in the verb.** The check is the closed set's,
 * and seating it in the verb is what lets the refusal name the whole vocabulary and seat it on `10`
 * rather than emit the parser's generic message.
 */

import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runAdd} from "./add-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runDrift} from "./drift-verb.ts";
import {runInit} from "./init-verb.ts";
import {runLookup} from "./lookup-verb.ts";
import {runSections} from "./sections-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".glossary"),
	Flag.withDescription(
		"the directory holding the registers, resolved against the target repo root",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the JSON shape on stdout instead of the line grammar"),
);

const registerFlag = (fallback: string, vocabulary: string) =>
	Flag.string("register").pipe(
		Flag.withDefault(fallback),
		Flag.withDescription(`which register to resolve against: one of ${vocabulary}`),
	);

const init = leafCommand(
	"init",
	{
		register: Flag.string("register").pipe(
			Flag.withDescription("which register to create: terms or language; both is refused"),
		),
		dir: dirFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({register, dir, json}) {
		yield* emit(yield* runInit({register, dir, json, cwd: process.cwd()}));
	}),
).pipe(
	Command.withShortDescription("Create a register file that does not exist yet."),
	Command.withDescription(
		"Create a register file that does not exist, so a fresh repo is not a dead end. Prints `created\\t<path>`, or the JSON object {action, path, register}. Exits 8 (the write failed, the outcome is UNKNOWN), 9 (written and the read-back does not match the template), 10 (--register both, or an off-enum value), 11 (a precondition read failed, nothing was written), 12 (the register already exists — refused, never overwritten). Example: fabrika glossary init --register terms",
	),
);

const drift = leafCommand(
	"drift",
	{
		register: registerFlag("terms", "terms, language, both"),
		dir: dirFlag,
		paths: Flag.string("paths").pipe(
			Flag.withDefault(""),
			Flag.withDescription(
				"comma-separated pathspecs to diff; the default is every tracked path, never a fixed layout",
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(40),
			Flag.withDescription("how many candidates to emit, highest-ranked first"),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({register, dir, paths, limit, json}) {
		yield* emit(yield* runDrift({register, dir, paths, limit, json, cwd: process.cwd()}));
	}),
).pipe(
	Command.withShortDescription("The surfaces that moved since the register last changed."),
	Command.withDescription(
		"The surfaces that moved since the register last changed, and the candidate coinages in them. Prints `drift`, `clean` or `bootstrap` on the first line — all three on exit 0 — then one `<phrase>\\t<hits>\\t<first-surface>` line per candidate. Exits 4 (the table structure is unparseable, so the declared set is UNKNOWN), 7 (--paths matched 0 tracked files), 10 (off-enum --register), 11 (--dir could not be read, or the range could not be computed). Example: fabrika glossary drift --register terms",
	),
);

const lookup = leafCommand(
	"lookup",
	{
		terms: Argument.string("term").pipe(
			Argument.atLeast(0),
			Argument.withDescription("the terms to resolve against the register(s), one line each"),
		),
		register: registerFlag("both", "terms, language, both"),
		dir: dirFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({terms, register, dir, json}) {
		yield* emit(yield* runLookup({terms, register, dir, json, cwd: process.cwd()}));
	}),
).pipe(
	Command.withShortDescription("Whether a term is already declared, and what overlaps it."),
	Command.withDescription(
		'Whether a term is already declared, and what overlaps it. Prints one `<state>\\t<register>\\t<section>\\t<matched>` line per term, in argument order — `declared`, `collision` and `absent` are all answers on exit 0. Exits 1 (no term given), 4 (a selected register has no parseable term table), 10 (off-enum --register), 11 (a selected register could not be read, so every state is UNKNOWN). Example: fabrika glossary lookup "front door" --register both',
	),
);

const sections = leafCommand(
	"sections",
	{register: registerFlag("terms", "terms, language, both"), dir: dirFlag, json: jsonFlag},
	Effect.fn(function* ({register, dir, json}) {
		yield* emit(yield* runSections({register, dir, json, cwd: process.cwd()}));
	}),
).pipe(
	Command.withShortDescription("The live section names of a register."),
	Command.withDescription(
		'The live section names of a register, so a caller reads them rather than recalling a list that rots. Prints one `<register>\\t<section>\\t<rows>` line per section in file order, or the single line `-\\tbootstrap\\t0` for a register that is absent or has no heading yet. Exits 4 (table rows under no "## " heading), 10 (off-enum --register), 11 (the register could not be read). Example: fabrika glossary sections --register terms',
	),
);

const add = leafCommand(
	"add",
	{
		term: Argument.string("term").pipe(
			Argument.withDescription("the term, written into the row's first cell verbatim"),
		),
		register: Flag.string("register").pipe(
			Flag.withDescription("which register to write: terms or language; both is refused"),
		),
		section: Flag.string("section").pipe(
			Flag.withDescription(
				"the section heading to insert under, matched verbatim against the live headings",
			),
		),
		definitionFile: Flag.string("definition-file").pipe(
			Flag.withDescription("the file holding the definition cell, or - for stdin"),
		),
		notFile: Flag.string("not-file").pipe(
			Flag.optional,
			Flag.withDescription("a file holding the Not cell; omitted means an empty third cell"),
		),
		replace: Flag.boolean("replace").pipe(
			Flag.withDescription(
				"rewrite the existing row for this term instead of refusing on collision",
			),
		),
		createSection: Flag.boolean("create-section").pipe(
			Flag.withDescription("create --section at the end of the register when it does not exist"),
		),
		dir: dirFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		term,
		register,
		section,
		definitionFile,
		notFile,
		replace,
		createSection,
		dir,
		json,
	}) {
		yield* emit(
			yield* runAdd({
				term,
				register,
				section,
				definitionFile,
				notFile: Option.getOrNull(notFile),
				replace,
				createSection,
				dir,
				json,
				cwd: process.cwd(),
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Insert or replace one row, alphabetically placed."),
	Command.withDescription(
		'Insert or replace one row, alphabetically placed and byte-preserving everywhere else. Prints `<action>\\t<path>\\t<section>\\t<line>`. Exits 3 (stdin held nothing), 4 (no parseable table under --section), 8/9 (the write failed, the read-back differs), 10 (--register both or an off-enum value), 11 (a precondition read failed — nothing was written), 12 (already declared without --replace, or --replace on an absent term), 13 (--section names no heading), 14 (the composed row cannot be a well-formed table row), 15 (the edit would have changed a line outside the target row — aborted). Example: printf \'The board product.\' | fabrika glossary add "pano" --register terms --section "Core / shape" --definition-file -',
	),
);

const check = leafCommand(
	"check",
	{
		register: registerFlag("both", "terms, language, both"),
		dir: dirFlag,
		decisions: Flag.string("decisions").pipe(
			Flag.optional,
			Flag.withDescription(
				"the decision-record directory a row's four-digit citations resolve against (default: the `decisionsDir` this repo declares)",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({register, dir, decisions, json}) {
		yield* emit(
			yield* runCheck({
				register,
				dir,
				decisions: Option.getOrNull(decisions),
				json,
				cwd: process.cwd(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"The shape, duplicate, ordering and citation defects in a register.",
	),
	Command.withDescription(
		"Row-shape, duplicate-key, cross-register, ordering and citation-liveness defects in a register. Prints `clean`, `defects` or `bootstrap` on the first line — all three on exit 0 — then one `<kind>\\t<register>\\t<section>\\t<term>\\t<detail>` line per finding. Machine-local paths and dead links are deliberately not computed: a merge-blocking gate already decides each. A row's four-digit citations resolve against the `decisionsDir` this repo declares unless --decisions names a directory; a repo that declines the key gets one `citations-unverified` finding naming the declaration, never a silent clean. Exits 4 (no parseable term table), 7 (a selected register is present and holds 0 rows), 10 (off-enum --register), 11 (a selected register, or `.fabrika.jsonc`, could not be read). Example: fabrika glossary check --register both",
	),
);

export const glossaryCommand = Command.make("glossary").pipe(
	Command.withSubcommands([init, drift, lookup, sections, add, check]),
	Command.withShortDescription("Maintain the repo's canonical vocabulary registers."),
	Command.withDescription(
		"Maintain the repo's canonical vocabulary registers: what is already declared, what moved since one last changed, where a row goes, and which rows have gone stale",
	),
);
