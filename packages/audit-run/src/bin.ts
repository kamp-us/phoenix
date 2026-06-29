/**
 * `audit-run run` — the thin Effect CLI for the on-demand rite-audit (#1517, epic #1510).
 *
 * One command provisions a fresh isolated audit stage, drives the operator-supplied agentic
 * explorer walk over the flag-on stage, aggregates + archives the dated verdict, ALWAYS tears
 * the stage down (even on a mid-run audit failure), and prints the per-dimension verdict.
 *
 * The walk is supplied as an external command (`--walk`) — the agentic explorer is an LLM
 * driving the Playwright MCP, so it runs out-of-process: this command hands it the live
 * stage's run context as `$RITE_AUDIT_RUN_CONTEXT` and reads its `{ dimensions: [...] }`
 * findings from stdout (see `adapter.ts`). No scheduling is added — the entry point is
 * on-demand only (scheduling/cron is an explicit later follow-up, out of scope per #1517).
 *
 * Credentials come from the environment, never source:
 *   $CLOUDFLARE_ACCOUNT_ID  the account the stage deploys into
 *   $CLOUDFLARE_API_TOKEN   the D1-write token
 *   $ALCHEMY_PASSWORD / $BETTER_AUTH_SECRET  passed through to `alchemy deploy/destroy`
 *
 *   node src/bin.ts run --walk '<command>' [--stage <name>] [--root <dir>]
 *
 * Run from the repo root so `pnpm --filter @kampus/web exec alchemy …` resolves the stack.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {DEFAULT_AUDIT_STAGE, makeStageLifecyclePort} from "@kampus/audit-stage";
import {Config, Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {findRepoRoot, makeFsArchiver, makeWalkFromCommand} from "./adapter.ts";
import {formatOperatorSummary, runAuditOnce} from "./run.ts";

const stageFlag = Flag.string("stage").pipe(
	Flag.withDefault(DEFAULT_AUDIT_STAGE),
	Flag.withDescription("the audit stage name to deploy/seed/destroy (default: audit)"),
);

const walkFlag = Flag.string("walk").pipe(
	Flag.withDescription(
		"the agentic explorer walk command; receives the run context as $RITE_AUDIT_RUN_CONTEXT and must print { dimensions: DimensionResult[] } to stdout",
	),
);

const rootFlag = Flag.string("root").pipe(
	Flag.optional,
	Flag.withDescription("repo root to write the run log under (default: walk up for one)"),
);

const run = Command.make(
	"run",
	{stage: stageFlag, walk: walkFlag, root: rootFlag},
	Effect.fn(function* ({stage, walk, root}) {
		const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
		const apiToken = yield* Config.string("CLOUDFLARE_API_TOKEN");
		const port = yield* makeStageLifecyclePort({appPackage: "@kampus/web", accountId, apiToken});
		const walkFn = yield* makeWalkFromCommand(walk);
		const repoRoot = Option.isSome(root) ? root.value : findRepoRoot(process.cwd());
		const archive = makeFsArchiver(repoRoot);
		yield* Console.log(
			`audit-run: provisioning stage '${stage}' and running the full rite-audit (provision → walk → archive → guaranteed teardown)…`,
		);
		const result = yield* runAuditOnce(
			{port, walk: walkFn, archive, now: () => new Date().toISOString()},
			stage,
		);
		yield* Console.log(formatOperatorSummary(result));
	}),
).pipe(
	Command.withDescription(
		"Provision → walk all dimensions → emit + archive the dated verdict → guaranteed teardown, for one on-demand rite-audit run",
	),
);

const cli = Command.make("audit-run").pipe(
	Command.withSubcommands([run]),
	Command.withDescription(
		"On-demand single-entry rite-audit — one command runs the full audit and always tears the stage down (#1517)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
