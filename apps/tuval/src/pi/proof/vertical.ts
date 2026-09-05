/**
 * The Pi vertical, booted and chatted — what every browser proof of this app starts from, and what
 * `./serve.ts` and `../../page/proof/serve.ts` both open a page onto.
 *
 * It boots the real app over the proof's own config (`./desk.ts`, Pi's faux provider — no key, no
 * model API, no cost), opens one Pi session **through the shell's own `window.open`** and chats it,
 * so a browser that attaches finds the desk already showing `PiChatWindow` over a real transcript.
 *
 * **The chatting is done here rather than in the browser** for a reason that is an open ticket, not
 * a choice: nothing on the shipped path opens a fresh agent session
 * ([#7925](https://github.com/kamp-us/phoenix/issues/7925)), so a window opened in the browser
 * would sit at "Not started." with every prompt refused.
 *
 * The caller owns the scope: the kernel this returns lives exactly as long as it, and the process
 * handles are only handles — nothing here stops or respawns a process.
 *
 * **Two turns is what one boot holds.** A third prompt is refused with `no-session` and the session
 * stays at `prompting` for ever — the lost phase event of
 * [#7897](https://github.com/kamp-us/phoenix/issues/7897). A proof that needs more turns boots a
 * second harness rather than asking this one for a third.
 */

import {mkdirSync, mkdtempSync, realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Context, Effect, Option} from "effect";
import type {AiAgentSessionState} from "../../ai-agent/core/index.ts";
import {boot, projectDir} from "../../boot.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessHandle} from "../../process/process.ts";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {activeWorkspace, type ShellState, windowIds} from "../../shell/core/index.ts";
import {windows} from "../../shell/layout/index.ts";
import {shellNode} from "../../shell/program.ts";
import {WindowId} from "../../shell/window/index.ts";
import {PI_SESSION_PROGRAM} from "../renderer-ref.ts";
import {PROJECT_ROOT_VAR} from "./names.ts";

/** `apps/tuval` — `index.html`'s home, and so the page server's root, as `src/bin.ts` computes it. */
export const appRoot = dirname(dirname(dirname(import.meta.dirname)));

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
export const until = (what: string, check: () => boolean, seen: () => unknown) =>
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

export interface ChattedVertical {
	readonly kernel: Context.Context<never>;
	readonly project: string;
	/** The Pi session the picker opened under the shell. A proof reads its id to prove it survived. */
	readonly agent: ProcessHandle;
	readonly replies: () => number;
	/** Send one prompt and wait for the reply it produces. The key is the transcript's, not a name. */
	readonly prompt: (text: string, key: string) => Effect.Effect<void>;
}

export const bootChattedVertical = Effect.fn("tuval.proof.bootChattedVertical")(
	function* (options: {readonly prompts: ReadonlyArray<string>}) {
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

		// The wait is on the reply *count*, never on the phase: a Pi turn can end with the core still at
		// `prompting` (#7897), so a gate on `ready` hangs on a session that is answering perfectly well.
		const prompt = (text: string, key: string) =>
			Effect.gen(function* () {
				const before = replies();
				yield* agent
					.dispatch({type: "prompt", text, key, timestamp: Date.now()})
					.pipe(Effect.orDie);
				yield* until(`the reply to "${text}"`, () => replies() > before, seen);
			});

		yield* until("the Pi session to open", () => session().phase === "ready", seen);
		for (const [index, text] of options.prompts.entries()) {
			yield* prompt(text, `harness-${index}`);
		}

		return {kernel, project, agent, replies, prompt} satisfies ChattedVertical;
	},
);
