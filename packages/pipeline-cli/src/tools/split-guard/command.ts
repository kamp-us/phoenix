/**
 * The `split-guard` tool — `pipeline-cli split-guard check --parent <N> --title "<child title>"`.
 *
 * The create-once guard for the `triage` skill's Step-3 split (#3464). Before the skill POSTs a
 * split child, it asks this tool whether a child that already covers `(parent, title)` exists —
 * keyed on the durable `split from #<parent>` back-reference, NOT body byte-equality — so a second
 * run of the split (a retry, or a re-emit) reuses the first child instead of firing a twin (the
 * #3462/#3463 double-fire).
 *
 * `check` prints the existing child's `#<n>` to stdout when a duplicate exists (⇒ the skill reuses
 * it, skips the POST), and prints nothing when none does (⇒ safe to create). It resolves the read
 * against the read-after-write `needs-triage` queue so a twin created seconds ago is still caught.
 * Exit 0 in both cases; the resolution goes to stderr. `GithubLive` is baked in with
 * `Command.provide(...)` so the registered command's residual requirement is the Node platform union.
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "./github.ts";
import {findExistingChild} from "./split-match.ts";

const QUEUE_LABEL = "status:needs-triage";

const parentFlag = Flag.integer("parent").pipe(
	Flag.withDescription("the parent issue number the split child would back-reference"),
);

const titleFlag = Flag.string("title").pipe(
	Flag.withDescription("the proposed split-child title (its unit-key is the create-once key)"),
);

const check = Command.make(
	"check",
	{parent: parentFlag, title: titleFlag},
	Effect.fn(function* ({parent, title}) {
		const gh = yield* Github;
		const existing = yield* gh.queue(QUEUE_LABEL);
		const dup = findExistingChild(parent, title, existing);
		if (dup === undefined) {
			process.stderr.write(
				`split-guard: no existing split-from-#${parent} child for this unit — safe to create\n`,
			);
			return;
		}
		yield* Console.log(`#${dup}`);
		process.stderr.write(
			`split-guard: #${dup} already covers this split of #${parent} — reuse it, do NOT create a twin\n`,
		);
	}),
).pipe(
	Command.withDescription(
		"Print the existing split child that already covers (parent, title), or nothing if safe to create",
	),
);

export const splitGuardCommand = Command.make("split-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Idempotency guard for the triage split step — key child-create on the split-from-#<parent> back-reference (#3464)",
	),
	Command.provide(GithubLive),
);
