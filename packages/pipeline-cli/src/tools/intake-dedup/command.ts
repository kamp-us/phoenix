/**
 * The `intake-dedup` tool — `pipeline-cli intake-dedup check --query "<text>"`.
 *
 * The ADR-0181 "is there already an open issue for this?" check, extracted from the inline
 * dual `gh api` query the `report` (pre-file) and `triage` (intake / split-pre-create) skills
 * each hand-maintained. One tested implementation wired at both intake seams — no drift.
 *
 * `check` fuses the two sources the skills ran by hand — the read-after-write `needs-triage`
 * queue + the eventually-consistent search index — into one deduped, title-overlap-ranked
 * candidate list, printed one `#<n>\t<title>` line per candidate to stdout (empty output = no
 * likely duplicate). It is advisory, not an oracle (ADR 0181; a duplicate is cheap to close, a
 * lost observation is gone), so it exits 0 whether or not it finds candidates; the count and any
 * refusal go to stderr. `GithubLive` is baked in with `Command.provide(...)` so the registered
 * command's residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {rankCandidates, tokenize} from "./dedup-match.ts";
import {Github, GithubLive} from "./github.ts";

const DEFAULT_LABEL = "status:needs-triage";
const DEFAULT_LIMIT = 20;

const queryFlag = Flag.string("query").pipe(
	Flag.withDescription(
		"the observation text (title + keywords) to check for an existing open issue",
	),
);

const labelFlag = Flag.string("label").pipe(
	Flag.withDefault(DEFAULT_LABEL),
	Flag.withDescription(`the intake-queue label to list (default: ${DEFAULT_LABEL})`),
);

const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(DEFAULT_LIMIT),
	Flag.withDescription(`max candidates to print (default: ${DEFAULT_LIMIT})`),
);

const excludeFlag = Flag.integer("exclude").pipe(
	Flag.optional,
	Flag.withDescription(
		"an issue number to omit from results — the issue being deduped, so it never flags itself",
	),
);

const check = Command.make(
	"check",
	{query: queryFlag, label: labelFlag, limit: limitFlag, exclude: excludeFlag},
	Effect.fn(function* ({query, label, limit, exclude}) {
		const tokens = tokenize(query);
		// No usable keywords ⇒ the search half would match everything and the queue half nothing;
		// there is no meaningful dedup to run, so surface that on stderr and exit clean (advisory).
		if (tokens.length === 0) {
			process.stderr.write("intake-dedup: no usable keywords in --query — nothing to check\n");
			return;
		}
		const gh = yield* Github;
		const [queue, search] = yield* Effect.all([gh.queue(label), gh.search(tokens)], {
			concurrency: "unbounded",
		});
		const candidates = rankCandidates({
			queue,
			search,
			tokens,
			exclude: Option.getOrUndefined(exclude),
			limit,
		});
		for (const c of candidates) yield* Console.log(`#${c.number}\t${c.title}`);
		process.stderr.write(
			`intake-dedup: ${candidates.length} candidate duplicate(s) for [${tokens.join(" ")}]\n`,
		);
	}),
).pipe(
	Command.withDescription(
		"List open issues that may already cover an observation (the ADR-0181 pre-file / intake dedup check)",
	),
);

export const intakeDedupCommand = Command.make("intake-dedup").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"The ADR-0181 unified intake-dedup check — one tested query shared by the report + triage seams",
	),
	Command.provide(GithubLive),
);
