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
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {runAdd} from "./add-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runDrift} from "./drift-verb.ts";
import {runInit} from "./init-verb.ts";
import {runLookup} from "./lookup-verb.ts";
import {runSections} from "./sections-verb.ts";

const dirFlag = Flag.string("dir").pipe(
	Flag.withDefault(".glossary"),
	Flag.withDescription(
		"the directory holding the registers, resolved against the target repo root",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
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
		[
			"Creates an absent register file from its template and prints `created\\t<path>`.",
			"  8: the write failed (UNKNOWN)",
			"  9: the read-back does not match the template",
			"  10: --register both, or an off-enum value",
			"  11: a precondition read failed; nothing was written",
			"  12: the register already exists and is never overwritten",
			'  Derivation: the glossary skill\'s contract.md, "glossary init"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika glossary init --register terms"}]),
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
		[
			"Prints drift, clean or bootstrap, each an answer, then one line per candidate coinage.",
			"  4: the table is unparseable, so the declared set is UNKNOWN",
			"  7: --paths matched 0 tracked files",
			"  10: an off-enum --register",
			"  11: --dir could not be read, or the range could not be computed",
			'  Derivation: the glossary skill\'s contract.md, "glossary drift"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika glossary drift --register terms"}]),
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
		[
			"Prints one `<state>\\t<register>\\t<section>\\t<matched>` line per term, in argument order.",
			"  declared, collision and absent are all answers.",
			"  4: a selected register has no parseable term table",
			"  10: an off-enum --register",
			"  11: a selected register could not be read, so every state is UNKNOWN",
			'  Derivation: the glossary skill\'s contract.md, "glossary lookup"',
		].join("\n"),
	),
	Command.withExamples([{command: 'fabrika glossary lookup "front door" --register both'}]),
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
		[
			"Prints one `<register>\\t<section>\\t<rows>` line per section of a register, in file order.",
			"  An absent or headingless register prints `-\\tbootstrap\\t0`.",
			"  4: table rows sit under no heading",
			"  10: an off-enum --register",
			"  11: the register could not be read",
			'  Derivation: the glossary skill\'s contract.md, "glossary sections"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika glossary sections --register terms"}]),
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
			Flag.withDefault(false),
			Flag.withDescription(
				"rewrite the existing row for this term instead of refusing on collision",
			),
		),
		createSection: Flag.boolean("create-section").pipe(
			Flag.withDefault(false),
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
		[
			"Inserts or replaces one register row in alphabetical place and prints where it landed.",
			"  3: stdin held nothing",
			"  4: no parseable table under --section",
			"  8: the write failed",
			"  9: the read-back differs",
			"  10: --register both, or an off-enum value",
			"  11: a precondition read failed; nothing was written",
			"  12: declared without --replace, or --replace on an absent term",
			"  13: --section names no heading",
			"  14: the composed row cannot be a well-formed table row",
			"  15: the edit would change another line, so it was aborted",
			'  Derivation: the glossary skill\'s contract.md, "glossary add"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'printf \'The board product.\' | fabrika glossary add "pano" --register terms --section "Core / shape" --definition-file -',
		},
	]),
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
		[
			"Prints clean, defects or bootstrap, each an answer, then one line per register defect found.",
			"  4: no parseable term table",
			"  7: a selected register is present and holds 0 rows",
			"  10: an off-enum --register",
			"  11: a selected register, or .fabrika.jsonc, could not be read",
			'  Derivation: the glossary skill\'s contract.md, "glossary check"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika glossary check --register both"}]),
);

export const glossaryCommand = Command.make("glossary").pipe(
	Command.withSubcommands([init, drift, lookup, sections, add, check]),
	Command.withShortDescription("Maintain the repo's canonical vocabulary registers."),
	Command.withDescription(
		"Maintain the repo's canonical vocabulary registers: what is already declared, what moved since one last changed, where a row goes, and which rows have gone stale",
	),
);
