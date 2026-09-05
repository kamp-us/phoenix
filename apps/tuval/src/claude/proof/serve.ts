/**
 * The Claude vertical on the **real CLI**, in a real browser: `pnpm proof:claude-real` from
 * `apps/tuval`.
 *
 * **This is the founder's run and nobody else's.** It boots `./real.ts` — the real
 * `ClaudeAiAgent.layer` on the operator's own Claude Code login, and the real `pi-session` row
 * beside it — so it spawns the `claude` CLI, talks to Anthropic and costs money. No workflow reaches
 * this file; the variant CI runs is `./claude-vertical.integration.test.ts`, on scripted layers with
 * zero model spend (founder ruling on #7582 and #7586).
 *
 * It chats nothing itself. Where the Pi harness (`../../pi/proof/serve.ts`) opens a session and
 * prompts it before serving, this one serves an empty desk on purpose: what the run is evidence
 * *of* is a person opening the picker, chatting, answering a real permission card, switching the
 * mode, restarting, and finding the chat still there with Pi in the other split.
 *
 * The project root is stable across runs rather than a fresh temp dir, because the restart step is
 * the whole point: stop the process, run it again with the same `--project`, and the desk and the
 * transcript have to come back.
 *
 * What to record afterwards, as a comment on
 * [#7625](https://github.com/kamp-us/phoenix/issues/7625): the SDK and CLI versions the start log
 * line printed, and whether the resumed CLI re-asked for a tool call that was left unanswered.
 */

import {mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {boot, projectDir} from "../../boot.ts";
import {servePage} from "../../page/dev-server.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import {PROJECT_ROOT_VAR} from "./names.ts";

/** `apps/tuval` — `index.html`'s home, and so the page server's root, as `src/bin.ts` computes it. */
const appRoot = dirname(dirname(dirname(import.meta.dirname)));

const configModule = fileURLToPath(new URL("./real.ts", import.meta.url));

const proof = Command.make(
	"claude-real-proof",
	{
		project: Flag.string("project").pipe(
			Flag.withDescription(
				"The project root: the session cwd and where the checkpoints live. Reuse it to prove the restart.",
			),
			Flag.withDefault(join(tmpdir(), "tuval-claude-real-proof")),
		),
		pagePort: Flag.integer("page-port").pipe(
			Flag.withDescription("Port for the page (default: a free one)"),
			Flag.withDefault(0),
		),
	},
	Effect.fn(function* ({project, pagePort}) {
		mkdirSync(projectDir(project), {recursive: true});
		process.env[PROJECT_ROOT_VAR] = project;

		const booted = yield* boot({global: configModule, project});
		const transport = yield* serveDesk({kernel: booted.kernel, port: 0, table: defaultPrefixTable});
		const page = yield* servePage({root: appRoot, transport, port: pagePort}).pipe(Effect.orDie);
		yield* Console.log(`claude-real proof: project ${project}`);
		yield* Console.log(`claude-real proof: desk at ${page.url}`);
		yield* Console.log(
			"claude-real proof: open that URL, pick claude-session in the empty window, and chat. Ctrl-C stops; run again with the same --project to prove the restart.",
		);
		return yield* Effect.never;
	}, Effect.scoped),
).pipe(
	Command.withDescription(
		"Boot the Claude vertical on the REAL Claude Code CLI and serve the desk. Local only: it spends model tokens.",
	),
);

proof.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
