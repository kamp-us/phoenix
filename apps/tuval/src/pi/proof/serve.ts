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
 * It boots the real app over the proof's own config (`./desk.ts`, Pi's faux provider — no key, no
 * model API, no cost), opens one Pi session **through the shell's own `window.open`** and chats it
 * twice, then serves the real page. So a browser that attaches finds the desk already showing
 * `PiChatWindow` over a real transcript: open the URL and the whole vertical is on screen.
 *
 * **The chatting is done here rather than in the browser** for a reason that is an open ticket, not
 * a choice: nothing on the shipped path opens a fresh agent session
 * ([#7925](https://github.com/kamp-us/phoenix/issues/7925)), so a window opened in the browser
 * would sit at "Not started." with every prompt refused.
 */

import {mkdirSync, mkdtempSync, realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Context, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import type {AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {servePage} from "../../page/dev-server.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {activeWorkspace, type ShellState, windowIds} from "../../shell/core/index.ts";
import {serveDesk} from "../../shell/host/index.ts";
import {defaultPrefixTable} from "../../shell/keys/index.ts";
import {windows} from "../../shell/layout/index.ts";
import {shellNode} from "../../shell/program.ts";
import {WindowId} from "../../shell/window/index.ts";
import {PI_SESSION_PROGRAM} from "../renderer-ref.ts";
import {PROJECT_ROOT_VAR, PROMPT_1, PROMPT_2} from "./names.ts";

/** `apps/tuval` — `index.html`'s home, and so the page server's root, as `src/bin.ts` computes it. */
const appRoot = dirname(dirname(dirname(import.meta.dirname)));

const configModule = fileURLToPath(new URL("./desk.ts", import.meta.url));

/** A fresh project root per run, so the harness never resumes a session an earlier run left behind. */
const freshProject = (): string => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "tuval-pi-vertical-proof-")));
	mkdirSync(projectDir(dir));
	process.env[PROJECT_ROOT_VAR] = dir;
	return dir;
};

/**
 * Poll a process's own state. The harness holds the kernel, so this is a handle read, not a claim,
 * and the state it last saw rides the failure — a stall on a real Pi session is diagnosable off the
 * failure line or not at all.
 */
const until = (what: string, check: () => boolean, seen: () => unknown) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 12_000 && !check(); attempt += 1) {
			yield* Effect.sleep("10 millis");
		}
		if (!check()) {
			return yield* Effect.die(
				new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(seen())}`),
			);
		}
	});

const proof = Command.make(
	"pi-vertical-proof",
	{
		pagePort: Flag.integer("page-port").pipe(
			Flag.withDescription("Port for the page (default: a free one)"),
			Flag.withDefault(0),
		),
	},
	Effect.fn(function* ({pagePort}) {
		const project = freshProject();
		const {kernel} = yield* boot({global: configModule, project});

		// The shell opens it, not this file: `window.open` is the picker's own route
		// (`../../shell/picker/open.ts`), so the process the page then offers is one a founder's
		// keystroke would have produced. Spawning it here by hand would be a different process with a
		// different service context, and the difference is not observable until it stalls.
		const processes = Context.get(kernel, Processes);
		const handleOf = (id: string) =>
			processes.handle(ProcessId.make(id)).pipe(
				Effect.provideContext(kernel),
				Effect.flatMap((held) =>
					Option.isNone(held)
						? Effect.die(new Error(`this kernel runs no process ${id}`))
						: Effect.succeed(held.value),
				),
			);
		const shell = yield* handleOf(shellNode);
		const activeOf = () => activeWorkspace(shell.getState() as ShellState);
		const first = activeOf();
		if (first === undefined) {
			return yield* Effect.die(new Error("the shell booted with no active workspace"));
		}
		const windowId = WindowId.make(windowIds(first)[0] as string);
		const bound = (): string | null => {
			const active = activeOf();
			if (active === undefined) return null;
			for (const window of windows(active.layout.root)) {
				if (window.id === windowId) return window.processId;
			}
			return null;
		};
		yield* shell.dispatch({
			type: "window.open",
			windowId,
			programId: ProgramId.make(PI_SESSION_PROGRAM),
		});
		yield* until(
			"the picker to bind the window",
			() => bound() !== null,
			() => shell.getState(),
		);
		const agent = yield* handleOf(bound() as string);

		const session = () => agent.getState() as AiAgentSessionState;
		const replies = () =>
			session().transcript.items.filter((item) => item.kind === "assistant").length;

		const seen = () => ({phase: session().phase, failure: session().failure, replies: replies()});
		yield* until("the Pi session to open", () => session().phase === "ready", seen);
		for (const [index, text] of [PROMPT_1, PROMPT_2].entries()) {
			const before = replies();
			yield* agent
				.dispatch({type: "prompt", text, key: `harness-${index}`, timestamp: Date.now()})
				.pipe(Effect.orDie);
			yield* until(`the reply to "${text}"`, () => replies() > before, seen);
		}

		const transport = yield* serveDesk({kernel, port: 0, table: defaultPrefixTable});
		const page = yield* servePage({root: appRoot, transport, port: pagePort}).pipe(Effect.orDie);
		yield* Console.log(`pi-vertical proof: project ${project}`);
		yield* Console.log(
			`pi-vertical proof: process ${agent.id}, ${replies()} reply(ies) on the tail`,
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
