/**
 * The `ci` verb group — the workflow plumbing a repo's release and build paths call.
 *
 * Not guards. These three are the release path and the CI build path: `ci changelog` and
 * `ci pr-body` are what let a release cut at all, and `ci annotate` is what puts a failed typecheck
 * on the diff. A mistake here breaks cutting rather than a check, which is why they are grouped apart from
 * `guard`.
 *
 * Two members of the group are not verbs but bare entry points, each because its job installs no
 * dependencies and an Effect CLI command would put the whole dependency tree on its critical path:
 * `ci-required` (`./required-bin.ts`), the always-on aggregator, and the main alarm
 * (`./main-alarm-bin.ts`), which reports a red push to the default branch and so must not depend on
 * the install that may be what broke.
 *
 * The adapter and nothing else: it declares the flags, reads the machine facts the verbs do not
 * derive, runs the verb, and emits its outcome.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {passThroughStdin, runAnnotate} from "./annotate-verb.ts";
import {runChangelog} from "./changelog-verb.ts";
import {runPrBody} from "./pr-body-verb.ts";

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("the repo root to resolve against (default: walk up from the cwd)"),
);

const changelog = leafCommand(
	"changelog",
	{
		entries: Flag.file("entries").pipe(
			Flag.withDescription(
				"path to the gathered entries JSON (a release range's closed-issue/merged-PR facts)",
			),
		),
		version: Flag.string("version").pipe(
			Flag.withDescription("the release version for the ## [version] heading"),
		),
		date: Flag.string("date").pipe(
			Flag.optional,
			Flag.withDescription("release date (YYYY-MM-DD); defaults to today (UTC)"),
		),
		out: Flag.string("out").pipe(
			Flag.optional,
			Flag.withDescription("write the changelog here; defaults to stdout"),
		),
	},
	Effect.fn(function* ({entries, version, date, out}) {
		yield* emit(
			yield* runChangelog({
				entries,
				version,
				date: Option.getOrNull(date),
				out: Option.getOrNull(out),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Derive one Keep-a-Changelog release section from shipped work."),
	Command.withDescription(
		"Derive one Keep a Changelog release section from a gathered entries JSON — the closed-issue titles and their triaged `type:*` labels for a release range, with a merged-PR backlink each. CHANGELOG.md is a projection of that pipeline metadata rather than a hand-edited doc, and an entry whose issue carries no recognized `type:*` lands under Uncategorized instead of being dropped. Prints the changelog on stdout, or writes it to --out with the progress line on stderr. Exits 4 (the entries file is not valid JSON, or not a ChangelogEntry[]), 8 (--out could not be written, so whether it landed is UNKNOWN), 11 (the entries file could not be read). Example: fabrika ci changelog --entries entries.json --version 0.3.1 --out CHANGELOG.md",
	),
);

const prBody = leafCommand(
	"pr-body",
	{},
	Effect.fn(function* () {
		yield* emit(yield* runPrBody({stdin: readStdin}));
	}),
).pipe(
	Command.withShortDescription("Neutralize stray HTML tags in a Release PR body, on stdin."),
	Command.withDescription(
		"Read a standing Release PR body on stdin and print one release-please can parse back. release-please copies each commit subject verbatim into the body's changelog and reads that body back through an HTML parser, so a subject carrying a literal <details> makes the body unparseable, and every green run rebuilds it from the same subject. Every HTML-looking tag loses its brackets EXCEPT the two lines release-please writes as structure itself. Empty stdout means the body already parses — write back exactly when there is something to write. Exit 0 on any completed read, repaired or not: this is a repair, not a gate. Exits 3 (nothing was piped in, or the body is empty), 11 (fd 0 could not be read, so the body is UNKNOWN). Example: gh api repos/o/r/pulls/42 --jq .body | fabrika ci pr-body",
	),
);

const annotate = leafCommand(
	"annotate",
	{
		force: Flag.boolean("force").pipe(
			Flag.withDefault(false),
			Flag.withDescription("emit annotations outside GitHub Actions too (local verification)"),
		),
		root: rootFlag,
	},
	Effect.fn(function* ({force, root}) {
		yield* runAnnotate({
			force,
			root: Option.getOrNull(root),
			cwd: process.cwd(),
			env: process.env,
			passThrough: passThroughStdin,
			write: (line) => process.stdout.write(`${line}\n`),
			warn: (line) => process.stderr.write(`${line}\n`),
		});
	}),
).pipe(
	Command.withShortDescription("Echo a typecheck through, annotating each tsc diagnostic."),
	Command.withDescription(
		"A pass-through filter for the CI typecheck step: echo stdin to stdout byte-for-byte, then re-emit each tsc/tsgo diagnostic as a ::error file=,line=,col= workflow command so a failed typecheck renders inline on the PR diff. tsc ships no annotations reporter. Paths are re-rooted from package-relative to repo-relative using the workspace member map, reading BOTH of turbo's package attributions — the per-line prefix and the grouped-header form CI actually gets. Annotations are CI-only unless --force. It ALWAYS exits 0 and never swallows a line: the typecheck's redness rides on the producer's exit code through `set -o pipefail`. Example: pnpm typecheck | fabrika ci annotate",
	),
);

export const ciCommand = Command.make("ci").pipe(
	Command.withSubcommands([changelog, prBody, annotate]),
	Command.withShortDescription("The release-path and build-path verbs CI workflows call."),
	Command.withDescription(
		"The workflow plumbing: `fabrika ci <verb>`. Unlike `guard`, these do not judge the tree — they are the release path (`changelog`, `pr-body`) and the build path (`annotate`), where a mistake breaks cutting or breaks a failed typecheck's annotations, rather than breaking a check",
	),
);
