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
		[
			"Prints one Keep a Changelog release section derived from an entries JSON, or writes it to --out.",
			"  An entry with no recognized `type:*` lands under Uncategorized, never dropped.",
			"  4: the entries file is not a valid ChangelogEntry[] JSON",
			"  8: --out could not be written (UNKNOWN)",
			"  11: the entries file could not be read",
			"  Derivation: packages/fabrika-cli/src/ci/changelog.ts",
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika ci changelog --entries entries.json --version 0.3.1 --out CHANGELOG.md"},
	]),
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
		[
			"Prints the stdin Release PR body with stray HTML tags defused, or nothing when it already parses.",
			"  Any completed read succeeds, repaired or not: this is a repair, not a gate.",
			"  3: nothing was piped in, or the body is empty",
			"  11: fd 0 could not be read (UNKNOWN)",
			"  Derivation: packages/fabrika-cli/src/ci/pr-body.ts",
		].join("\n"),
	),
	Command.withExamples([{command: "gh api repos/o/r/pulls/42 --jq .body | fabrika ci pr-body"}]),
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
		[
			"Echoes stdin to stdout unchanged, then prints a `::error` workflow command per tsc diagnostic.",
			"  Always succeeds and drops no line; the typecheck's status rides `set -o pipefail`.",
			"  Derivation: packages/fabrika-cli/src/ci/tsc-annotate.ts",
		].join("\n"),
	),
	Command.withExamples([{command: "pnpm typecheck | fabrika ci annotate"}]),
);

export const ciCommand = Command.make("ci").pipe(
	Command.withSubcommands([changelog, prBody, annotate]),
	Command.withShortDescription("The release-path and build-path verbs CI workflows call."),
	Command.withDescription(
		"The workflow plumbing: `fabrika ci <verb>`. Unlike `guard`, these do not judge the tree — they are the release path (`changelog`, `pr-body`) and the build path (`annotate`), where a mistake breaks cutting or breaks a failed typecheck's annotations, rather than breaking a check",
	),
);
