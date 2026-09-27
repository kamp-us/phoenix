/**
 * The `wire` verb group — `fabrika wire <verb>`.
 *
 * The adapter and nothing else: it declares the flags, runs the pure verb, and emits its outcome.
 * Every decision lives in the `*-verb.ts` modules beside it, which is what makes each refusal
 * testable without spawning a process.
 *
 * The leaves are **flat** — `emit` / `read` / `check` select their format with `--format`, never
 * with a `wire ac emit` sub-group. Every other group is group→leaf, and the `--help` path guard and
 * the excess-operand catch-all are only exercised at that depth.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {fileURLToPath} from "node:url";
import {Effect, type FileSystem, Option, type Path, Result} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit as emitOutcome} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readFile, writeFile} from "../io/fs.ts";
import {readStdin, type StdinRead} from "../io/stdin.ts";
import {runCheck} from "./check-verb.ts";
import {runCodes} from "./codes-verb.ts";
import {runDocSection} from "./doc-section-verb.ts";
import {runEmit} from "./emit-verb.ts";
import {runFormats} from "./formats-verb.ts";
import {DOC_PATH} from "./index-doc.ts";
import {type DocRead, type DocSave, runIndex} from "./index-verb.ts";
import {runRead} from "./read-verb.ts";
import {registeredFormats, registeredKeys} from "./registry.ts";

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDefault(false),
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

/**
 * The registered keys are interpolated into the description rather than restated, so `--help` can
 * never advertise a format the registry does not hold.
 */
const formatFlag = Flag.string("format").pipe(
	Flag.withDescription(`the wire format to act on: one of ${registeredKeys().join(", ")}`),
);

const codes = leafCommand(
	"codes",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emitOutcome(runCodes({json}));
	}),
).pipe(
	Command.withShortDescription("Print the exit taxonomy this group allocates from."),
	Command.withDescription(
		[
			"Prints the exit taxonomy this group allocates from, one `<code>\\t<meaning>` line per code.",
			"  Reads nothing and always succeeds.",
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika wire codes"}]),
);

const formats = leafCommand(
	"formats",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emitOutcome(runFormats({json}));
	}),
).pipe(
	Command.withShortDescription("List the registered wire formats, from the registry."),
	Command.withDescription(
		[
			"Prints `formats\\t<n>`, then one `<key>\\t<purpose>\\t<producers>\\t<consumers>` line per format.",
			"  7: no format is registered (zero scope)",
			"  Derivation: claude-plugins/fabrika/docs/wire-formats.md",
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika wire formats"}]),
);

const emit = leafCommand(
	"emit",
	{format: formatFlag, json: jsonFlag},
	Effect.fn(function* ({format, json}) {
		yield* emitOutcome(yield* runEmit({format, json, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription("Compose a format's bytes from the fields on stdin."),
	Command.withDescription(
		[
			"Composes a format's block from the fields on stdin and prints it; `wire read` reads it back.",
			"  For acceptance-criteria, one criterion per line, optionally prefixed `[x]` or `[ ]`.",
			"  5: stdin was read and held nothing",
			"  6: stdin could not be read (UNKNOWN)",
			"  7: --format names no registered format",
			"  8: the fields hold no usable criterion",
			"  Derivation: claude-plugins/fabrika/docs/wire-formats.md",
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika wire emit --format acceptance-criteria < criteria.txt"},
	]),
);

const read = leafCommand(
	"read",
	{format: formatFlag, json: jsonFlag},
	Effect.fn(function* ({format, json}) {
		yield* emitOutcome(yield* runRead({format, json, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription("Read a format's block out of the artifact on stdin."),
	Command.withDescription(
		[
			"Prints `found\\t<format>\\t<count>`, then one line per field of the stdin artifact's block.",
			"  3: proven absent; nothing reaches for the block",
			"  4: present and malformed; the reason and bytes are on stderr",
			"  5: stdin was read and held nothing",
			"  6: the artifact could not be read (UNKNOWN)",
			"  7: --format names no registered format",
			"  Derivation: claude-plugins/fabrika/docs/wire-formats.md",
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika wire read --format acceptance-criteria < issue-body.md"},
	]),
);

const check = leafCommand(
	"check",
	{format: formatFlag, json: jsonFlag},
	Effect.fn(function* ({format, json}) {
		yield* emitOutcome(yield* runCheck({format, json, stdin: Effect.sync(readStdin)}));
	}),
).pipe(
	Command.withShortDescription("Whether the artifact on stdin carries a conforming block."),
	Command.withDescription(
		[
			"Prints `conforms\\t<format>\\t<count>` when the stdin artifact carries a conforming block.",
			"  The scope judged is on stderr on every path.",
			"  3: proven absent",
			"  4: present and malformed",
			"  5: stdin was read and held nothing",
			"  6: the artifact could not be read (UNKNOWN)",
			"  7: --format names no registered format (zero scope)",
			"  Derivation: claude-plugins/fabrika/docs/wire-formats.md",
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika wire check --format acceptance-criteria < issue-body.md"},
	]),
);

/** `--file` lifted into the stdin shape, so the verb keeps one UNKNOWN-vs-empty classification. */
const readDocFile = (path: string): Effect.Effect<StdinRead, never, FileSystem.FileSystem> =>
	Effect.map(Effect.result(readFile(path)), (read) =>
		Result.isFailure(read)
			? ({_tag: "Failed", reason: read.failure.reason} satisfies StdinRead)
			: ({_tag: "Text", text: read.success} satisfies StdinRead),
	);

const docSection = leafCommand(
	"doc-section",
	{
		heading: Flag.string("heading").pipe(
			Flag.withDescription("the ATX heading text naming the section to print"),
		),
		file: Flag.string("file").pipe(
			Flag.optional,
			Flag.withDescription("read the document from this path instead of stdin"),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({heading, file, json}) {
		const source: Effect.Effect<StdinRead, never, FileSystem.FileSystem> = Option.match(file, {
			onNone: () => Effect.sync(readStdin),
			onSome: readDocFile,
		});
		yield* emitOutcome(yield* runDocSection({heading, json, source}));
	}),
).pipe(
	Command.withShortDescription("Print one markdown section of a document by heading."),
	Command.withDescription(
		[
			"Prints the section of the stdin or --file markdown under the ATX heading whose text is --heading.",
			"  The section runs to the next heading of equal or shallower depth; fenced headings are ignored.",
			"  3: no heading outside a fence carries that text",
			"  4: the heading occurs more than once",
			"  5: the document was read and held nothing",
			"  6: the document could not be read (UNKNOWN)",
		].join("\n"),
	),
	Command.withExamples([
		{command: 'fabrika wire doc-section --heading "build claim" < contract.md'},
	]),
);

/**
 * The doc's location on disk, resolved from this module rather than from the process's cwd — the
 * verb answers about the checkout it ships in, wherever `fabrika` was invoked from.
 */
const indexDocFile = (): string =>
	fileURLToPath(new URL(`../../../../${DOC_PATH}`, import.meta.url));

const readIndexDoc: Effect.Effect<DocRead, never, FileSystem.FileSystem> = Effect.gen(function* () {
	const read = yield* Effect.result(readFile(indexDocFile()));
	return Result.isFailure(read)
		? ({_tag: "Failed", reason: read.failure.reason} satisfies DocRead)
		: ({_tag: "Text", text: read.success} satisfies DocRead);
});

const saveIndexDoc = (
	markdown: string,
): Effect.Effect<DocSave, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const written = yield* Effect.result(writeFile(indexDocFile(), markdown));
		return Result.isFailure(written)
			? ({_tag: "Failed", reason: written.failure.reason} satisfies DocSave)
			: ({_tag: "Saved"} satisfies DocSave);
	});

const index = leafCommand(
	"index",
	{
		write: Flag.boolean("write").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"render the doc's generated region from the registry again, instead of only reporting on it",
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({write, json}) {
		yield* emitOutcome(
			yield* runIndex<FileSystem.FileSystem | Path.Path>({
				write,
				json,
				formats: registeredFormats,
				doc: readIndexDoc,
				save: saveIndexDoc,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Reconcile the wire-formats index doc with the registry."),
	Command.withDescription(
		[
			"Prints `index\\t<agrees|written>\\t<registered>\\t<documented>` for the index doc and registry.",
			"  4: the index and the registry disagree",
			"  6: the doc could not be read or written (UNKNOWN)",
			"  7: zero scope",
			'  Derivation: claude-plugins/fabrika/docs/wire-formats.md, "Adding a format"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika wire index --write"}]),
);

export const wireCommand = Command.make("wire").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing
		// one. The comment is what keeps the formatter from collapsing the list back.
		codes,
		formats,
		emit,
		read,
		check,
		docSection,
		index,
	]),
	Command.withShortDescription("Own the byte-level formats two skills meet through."),
	Command.withDescription(
		"Own the byte-level formats two skills meet through on a GitHub artifact — compose them, read them back totally (found / absent / malformed), check one without reading its fields, and keep the index doc rendered from the registry",
	),
);
