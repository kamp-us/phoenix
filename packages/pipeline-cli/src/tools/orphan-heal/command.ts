/**
 * The `orphan-heal` tool — `pipeline-cli orphan-heal scan [flags]`.
 *
 *   node src/bin.ts orphan-heal scan                 # dry-run: print the plan, file nothing
 *   node src/bin.ts orphan-heal scan --execute       # file one heal-item per detected orphan
 *   node src/bin.ts orphan-heal scan --grace-hours 3 # override the red-for grace window
 *
 * The #3532 boundary path, steps 1–2 (#3650): the DETECTOR reads the open-PR set + each
 * head's CI + lane state (all from existing state, REST only) and the EMITTER files one
 * triaged, immediately-claimable "heal red CI on PR #N" issue per orphan — idempotently
 * (skip if an open heal-item already targets the PR). It never mutates a PR and never lets an
 * engine free-scan; an engine adopts the resulting lane downstream (steps 3–5, existing
 * machinery). Dry-run by default so a human can eyeball the plan; the scheduled workflow
 * passes `--execute`. `GithubLive` is baked in with `Command.provide(...)` so the registered
 * command's residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Github, GithubLive} from "./github.ts";
import {healItemBody, healItemTitle, type PrSnapshot, planHealItems} from "./orphan-heal.ts";

/** The source issue this tool implements — cited in each heal-item body for provenance. */
const SOURCE_ISSUE = 3650;
/** A heal-item is triaged (a type + priority + the triaged status) and unassigned ⇒ immediately claimable. */
const HEAL_ITEM_LABELS = ["status:triaged", "type:chore", "p1"] as const;
const DEFAULT_GRACE_HOURS = 6;

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription("file the heal-items (default: dry-run — print the plan, file nothing)"),
);

const graceHoursFlag = Flag.integer("grace-hours").pipe(
	Flag.withDefault(DEFAULT_GRACE_HOURS),
	Flag.withDescription(
		`only flag a PR red at least this many hours (default: ${DEFAULT_GRACE_HOURS})`,
	),
);

const scan = Command.make(
	"scan",
	{execute: executeFlag, graceHours: graceHoursFlag},
	Effect.fn(function* ({execute, graceHours}) {
		const gh = yield* Github;
		const repo = yield* gh.repoName();
		const graceMs = graceHours * 60 * 60 * 1000;

		// Read once: the open-PR set + the existing heal-item targets (idempotency source).
		const [prs, existingHealTargets] = yield* Effect.all(
			[gh.listOpenPrs(), gh.existingHealTargets()],
			{concurrency: "unbounded"},
		);

		// Resolve each PR's head-CI + lane state into a snapshot the pure core decides over.
		const snapshots = yield* Effect.all(
			prs.map((pr) =>
				Effect.gen(function* () {
					const [ci, laneState] = yield* Effect.all(
						[gh.headCi(pr.headSha), gh.inEngineLane(pr.body)],
						{concurrency: "unbounded"},
					);
					return {
						number: pr.number,
						isDraft: pr.isDraft,
						ci: ci.conclusion,
						redSince: ci.redSince,
						laneState,
						failingCheck: ci.failingCheck,
					} satisfies PrSnapshot;
				}),
			),
			{concurrency: 8},
		);

		const {emit, skip} = planHealItems(snapshots, {
			graceMs,
			now: Date.now(),
			existingHealTargets,
		});

		process.stderr.write(
			`orphan-heal: ${prs.length} open PR(s) scanned — ${emit.length} orphan(s) to heal, ${skip.length} skipped (grace ${graceHours}h)\n`,
		);
		for (const s of skip) process.stderr.write(`  skip #${s.number}: ${s.reason} — ${s.detail}\n`);

		if (emit.length === 0) {
			yield* Console.log("no orphan red PRs to heal");
			return;
		}

		for (const item of emit) {
			const title = healItemTitle(item.number);
			if (!execute) {
				yield* Console.log(
					`[dry-run] would file: "${title}" (orphan-heal-target: #${item.number})`,
				);
				continue;
			}
			const body = healItemBody(item, {repo, sourceIssue: SOURCE_ISSUE});
			const created = yield* gh.createHealItem({title, body, labels: [...HEAL_ITEM_LABELS]});
			yield* Console.log(`filed #${created.number} → heals PR #${item.number}: ${created.url}`);
		}
	}),
).pipe(
	Command.withDescription(
		"Detect orphan red PRs and emit one idempotent, triaged heal-item each (#3532 boundary path; #3650)",
	),
);

export const orphanHealCommand = Command.make("orphan-heal").pipe(
	Command.withSubcommands([scan]),
	Command.withDescription(
		"Orphan-red-PR detector + heal-item emitter — convert a laneless red PR into pullable board work (#3532)",
	),
	Command.provide(GithubLive),
);
