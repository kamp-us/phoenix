/**
 * The Pi vertical in a real browser: `pnpm proof:pi-vertical` from `apps/tuval`.
 *
 * The integration proof beside this file reads everything off the transport, which is the right
 * read for what it asserts and no read at all for what a founder sees. jsdom has no layout, so the
 * paint claims — the transcript scrolls, the usage line sits in the status bar and wraps, the whole
 * desk reads dark — are unfalsifiable in the unit tier. The harness ships rather than being deleted
 * after the run (#7610, review-code FAIL 2026-09-05): a reviewer reproduces the load instead of
 * taking a report for it, and the founder's post-#7836 bar (a real-browser load with zero console
 * errors) is something anyone can re-run.
 *
 * The boot and the two turns are `./vertical.ts`'s; this file serves them. Open the URL it prints
 * and the whole vertical is on screen.
 */

import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {servePage} from "../../page/dev-server.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import {PROMPT_1, PROMPT_2} from "./names.ts";
import {appRoot, bootChattedVertical} from "./vertical.ts";

const proof = Command.make(
	"pi-vertical-proof",
	{
		pagePort: Flag.integer("page-port").pipe(
			Flag.withDescription("Port for the page (default: a free one)"),
			Flag.withDefault(0),
		),
		strictPort: Flag.boolean("strict-port").pipe(
			Flag.withDescription(
				"Bind --page-port exactly or fail the start, instead of falling back to the next free port",
			),
			Flag.withDefault(false),
		),
	},
	Effect.fn(function* ({pagePort, strictPort}) {
		const vertical = yield* bootChattedVertical({prompts: [PROMPT_1, PROMPT_2]});
		const transport = yield* serveDesk({
			kernel: vertical.kernel,
			port: 0,
			table: defaultPrefixTable,
		});
		const page = yield* servePage({root: appRoot, transport, port: pagePort, strictPort}).pipe(
			Effect.orDie,
		);
		yield* Console.log(`pi-vertical proof: project ${vertical.project}`);
		yield* Console.log(
			`pi-vertical proof: process ${vertical.agent.id}, ${vertical.replies()} reply(ies) on the tail`,
		);
		yield* Console.log(`pi-vertical proof: desk at ${page.url}`);
		yield* Console.log(
			"pi-vertical proof: open that URL — the chat is already on screen; Ctrl-C stops",
		);
		return yield* Effect.never;
	}, Effect.scoped),
).pipe(
	Command.withDescription(
		"Boot the Pi vertical on the faux provider, chat it twice, and serve the real desk",
	),
);

proof.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
