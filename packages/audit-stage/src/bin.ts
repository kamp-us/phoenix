/**
 * `audit-stage run` — the thin Effect CLI around {@link runStageLifecycle} (#1512).
 *
 * One command provisions a fresh isolated audit stage, seeds it, mints a login-able
 * test-mod, runs the (currently no-op) audit hook, and tears the stage down — with
 * teardown guaranteed on every exit path. Credentials come from the environment, never
 * source:
 *   $CLOUDFLARE_ACCOUNT_ID  the account the stage deploys into
 *   $CLOUDFLARE_API_TOKEN   the D1-write token (the D1 lookup curl bearer; the seeds read it via CredentialsFromEnv)
 *   $ALCHEMY_PASSWORD / $BETTER_AUTH_SECRET  passed through to `alchemy deploy/destroy`
 *
 *   node src/bin.ts run [--stage <name>]   (default stage: audit)
 *
 * Run from the repo root so `pnpm --filter @kampus/web exec alchemy …` resolves the stack.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Config, Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {DEFAULT_AUDIT_STAGE, makeStageLifecyclePort} from "./adapter.ts";
import {runStageLifecycle} from "./lifecycle.ts";

const stageFlag = Flag.string("stage").pipe(
	Flag.withDefault(DEFAULT_AUDIT_STAGE),
	Flag.withDescription("the audit stage name to deploy/seed/destroy (default: audit)"),
);

const run = Command.make(
	"run",
	{stage: stageFlag},
	Effect.fn(function* ({stage}) {
		const accountId = yield* Config.string("CLOUDFLARE_ACCOUNT_ID");
		const apiToken = yield* Config.string("CLOUDFLARE_API_TOKEN");
		const port = yield* makeStageLifecyclePort({appPackage: "@kampus/web", accountId, apiToken});
		yield* Console.log(`audit-stage: provisioning stage '${stage}' on the audit environment…`);
		const result = yield* runStageLifecycle(port, stage);
		yield* Console.log(
			`audit-stage: run complete — base URL ${result.baseUrl}, test-mod ${result.testMod.email}; stage torn down (no live flag-on stage left behind).`,
		);
	}),
).pipe(
	Command.withDescription(
		"Provision → seed → mint test-mod → run hook → guaranteed teardown for one audit run",
	),
);

const cli = Command.make("audit-stage").pipe(
	Command.withSubcommands([run]),
	Command.withDescription(
		"Ephemeral rite-audit stage lifecycle — deploy → seed → mint test-mod → guaranteed teardown (#1512)",
	),
);

cli.pipe(Command.run({version: "0.0.0"}), Effect.provide(NodeServices.layer), NodeRuntime.runMain);
