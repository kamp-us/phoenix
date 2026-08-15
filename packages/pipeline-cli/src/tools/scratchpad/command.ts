/**
 * The `scratchpad` tool — `pipeline-cli scratchpad <open|path|file> --slug <slug>`.
 *
 * The one allocator every agent calls instead of hand-rolling a scratch path
 * (#3718). It prints an absolute per-run directory (or a file inside it) on stdout and
 * NOTHING else, so a caller captures it directly:
 *
 *   RUN_SCRATCH="$(pipeline-cli scratchpad open --slug review-doc-3951)" || exit 1
 *   VERDICT="$(pipeline-cli scratchpad file --slug review-doc-3951 --name verdict.md)" || exit 1
 *
 * Every failure is a REFUSAL with a distinct exit code (2 missing session id, 3 bad
 * slug/name, 4 the namespace belongs to another run, 5 not opened in this run, 6 the
 * filesystem refused) and a reason on stderr. There is no fallback to a shared or default
 * location — a fallback is exactly what reintroduces the silent cross-run clobber.
 *
 * `open` is the run's first write; `path` and `file` re-derive in every later Bash call,
 * where shell state is already gone. See gh-issue-intake-formats.md §SP.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {exitCodeFor, type NamespaceInput, type Resolved} from "./scratchpad.ts";
import {openNamespace, resolveOwnFile, resolveOwnNamespace} from "./store.ts";

const slugFlag = Flag.string("slug").pipe(
	Flag.withDescription(
		"names the caller: the skill plus its work item (e.g. `review-doc-3951`, `write-code-3718`)",
	),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"TEST-ONLY override of the run identity to namespace under (default: $CLAUDE_CODE_SESSION_ID). Never pass it from a skill or agent: a fixed literal re-keys every caller onto one namespace, which is the shared surface this tool exists to remove",
	),
);

const nameFlag = Flag.string("name").pipe(
	Flag.withDescription("the leaf file name inside the namespace (e.g. `verdict.md`)"),
);

const inputFrom = (slug: string, session: Option.Option<string>): NamespaceInput => ({
	tmpdir: process.env.TMPDIR,
	session: Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? ""),
	pid: process.env.CLAUDE_PID,
	slug,
});

/** Print the resolved path on stdout, or the typed refusal on stderr and exit non-zero. */
const emit = (resolved: Resolved<string>) =>
	Effect.gen(function* () {
		if (!resolved.ok) {
			process.stderr.write(`scratchpad: ${resolved.error._tag} — ${resolved.error.message}\n`);
			process.exit(exitCodeFor(resolved.error));
		}
		yield* Console.log(resolved.value);
	});

const openCommand = Command.make(
	"open",
	{slug: slugFlag, session: sessionFlag},
	Effect.fn(function* ({slug, session}) {
		const resolved = openNamespace(inputFrom(slug, session));
		yield* emit(resolved.ok ? {ok: true, value: resolved.value.path} : resolved);
	}),
).pipe(
	Command.withDescription(
		"Allocate this run's scratch namespace fresh and stamp it as ours (refuses a namespace another run owns)",
	),
);

const pathCommand = Command.make(
	"path",
	{slug: slugFlag, session: sessionFlag},
	Effect.fn(function* ({slug, session}) {
		const resolved = resolveOwnNamespace(inputFrom(slug, session));
		yield* emit(resolved.ok ? {ok: true, value: resolved.value.path} : resolved);
	}),
).pipe(
	Command.withDescription(
		"Re-derive this run's scratch namespace in a later Bash call, asserting it exists and is still ours",
	),
);

const fileCommand = Command.make(
	"file",
	{slug: slugFlag, session: sessionFlag, name: nameFlag},
	Effect.fn(function* ({slug, session, name}) {
		yield* emit(resolveOwnFile(inputFrom(slug, session), name));
	}),
).pipe(
	Command.withDescription("Re-derive the path of one file inside this run's scratch namespace"),
);

export const scratchpadCommand = Command.make("scratchpad").pipe(
	Command.withSubcommands([openCommand, pathCommand, fileCommand]),
	Command.withDescription(
		"Allocate and re-derive the per-run scratch namespace (§SP) — fail-closed, never a shared path",
	),
);
