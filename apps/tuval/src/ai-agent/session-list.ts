/**
 * The session-list program row and the one spell on it: every registered ai-agent backend's
 * sessions, unioned, newest first, answered on demand.
 *
 * **Why a spell and not a frame.** A page cannot ask over the transport — `../shell/transport/wire.ts`
 * has no request frame, and `../shell/transport/server.ts` states the rule: a spell call is the only
 * message a page may send, so the kernel pushes everything else (ADR 0348 R1.3). The two pushed
 * frames beside it, `RegistryFrame` and `TableFrame`, are state the kernel already holds and
 * republishes on change. A session list is neither held nor changing: it is two session-store walks
 * off disk that an operator may never ask for, so pre-warming it would charge every page attach for
 * a list nobody opened. Answering it on demand is what a spell is.
 *
 * **This is the first spell in the tree that reads the filesystem.** The five existing spell modules
 * import neither `node:fs` nor `FileSystem` — their disk reads live a layer down — so the precedent
 * is set here deliberately rather than by accident. It is set at one remove even now: the IO is the
 * backends' own, reached through `listAiAgentSessions`, and `capabilities` declares the
 * `filesystem` family so a reader of the row sees it. That declaration is inert data the kernel
 * enforces nothing on (`../registry/program.ts`) and is not a security boundary.
 *
 * **Nothing else bounds a spell.** There is no timeout, deadline or duration budget anywhere on the
 * spell path, so a list that walks two Pi stores and every Claude project carries its own — an
 * overrun becomes `SessionListTimedOut`, which the executor turns into a `SpellReplyError`, rather
 * than a call the page waits on forever.
 */

import {type Cmd, defineMachine} from "@demlik/tea";
import {Cause, Context, Effect, Option, Schema} from "effect";
import {defineSpell} from "../commands/spell.ts";
import {SESSION_LIST_PATH, SessionList} from "../protocol/session-list.ts";
import type {AnyProgram, Program} from "../registry/program.ts";
import {ProgramId} from "../registry/program.ts";
import type {Registry} from "../registry/Registry.ts";
import {type AiAgentSessions, type BackendListFailure, listAiAgentSessions} from "./backends.ts";
import {SESSION_LIST_WINDOW_REF} from "./renderer-ref.ts";

/**
 * The union, as the spell reaches it. A service rather than a direct `listAiAgentSessions` call
 * because that function takes the context a backend's layer is built under — the same kernel
 * context a spawn of that row would run under — and a spell has no way to name it: `AnySpell`
 * erases a spell's requirements, so the composition root is where the obligation is spent
 * (`../commands/executor.ts`). `src/boot.ts` is that root and fills this from the kernel it built.
 */
export class AiAgentSessionList extends Context.Service<
	AiAgentSessionList,
	{
		/** Never fails: a backend that cannot answer is a reported failure, not this effect's. */
		readonly read: Effect.Effect<AiAgentSessions>;
	}
>()("tuval/AiAgentSessionList") {}

/**
 * The service over one kernel context. The context is both what satisfies the enumeration's
 * `Registry` and what each backend's layer is built under, exactly as `Processes.spawn` takes one
 * (#7951) — so a backend reaches the same services here that it would reach if it were spawned.
 */
export const aiAgentSessionListKernel = (
	services: Context.Context<Registry>,
): AiAgentSessionList["Service"] => ({
	read: listAiAgentSessions(services).pipe(Effect.provideContext(services)),
});

/** How long the whole union may take before the call answers with a refusal instead of waiting. */
export const SESSION_LIST_DEADLINE_MILLIS = 10_000;

export class SessionListTimedOut extends Schema.TaggedError<SessionListTimedOut>()(
	"tuval/SessionListTimedOut",
	{millis: Schema.Number},
) {
	override get message(): string {
		return `the session list did not answer within ${this.millis}ms`;
	}
}

/**
 * Why one backend could not answer, rendered. A store that refused the read carries its own
 * `ListError` and that error's sentence is the useful one; a backend whose layer died standing its
 * transport up carries no error at all, and the pretty-printed cause is the only honest thing left
 * to say about it.
 */
const detailOf = (cause: Cause.Cause<{readonly message: string}>): string => {
	const error = Cause.findErrorOption(cause);
	return Option.isNone(error) ? Cause.pretty(cause) : error.value.message;
};

const unreadableOf = (failure: BackendListFailure) => ({
	programId: failure.programId,
	provenance: failure.provenance,
	detail: detailOf(failure.cause),
});

const onTheWire = (answer: AiAgentSessions): SessionList => ({
	sessions: answer.sessions,
	unreadable: answer.failures.map(unreadableOf),
});

export interface SessionListSpellOptions {
	/** Hard bound on the whole union, in milliseconds. A parameter so a test can move it. */
	readonly deadlineMillis?: number;
}

export const sessionListSpell = ({
	deadlineMillis = SESSION_LIST_DEADLINE_MILLIS,
}: SessionListSpellOptions = {}) =>
	defineSpell({
		path: [...SESSION_LIST_PATH],
		describe: "List every registered AI agent's sessions as one list, newest first.",
		params: Schema.Struct({}),
		result: SessionList,
		execute: Effect.fn("Tuval.sessionList")(function* () {
			const listing = yield* AiAgentSessionList;
			return onTheWire(
				yield* listing.read.pipe(
					// A deadline that fires interrupts the read, so the caller reads it as the timeout it
					// is rather than waiting the disk walk out (`Effect.timeout`, `effect/Effect` rc.112:
					// "If the timeout wins, the source effect is interrupted").
					Effect.timeout(deadlineMillis),
					Effect.catchTag("TimeoutError", () => new SessionListTimedOut({millis: deadlineMillis})),
				),
			);
		}),
		capabilities: [{family: "filesystem", detail: "every registered backend's session store"}],
	});

export const sessionListId = ProgramId.make("ai-agent-sessions");

const SESSION_LIST_VERSION = "1.0.0";

type SessionListState = Record<never, never>;
type SessionListMsg = {readonly type: "opened"};

/**
 * The row the spell is declared on: the `TuvalAiAgent` session list, its own program rather than a
 * picker section (epic #8070, ruling 4).
 *
 * It carries no state worth the name: the surface is `./window/`'s and renders a list it is handed,
 * so nothing about it belongs in this process. `renderer` is what makes the row offerable at all —
 * a row without one is headless and left out of every picker list (`../shell/picker/entries.ts`)
 * — and `spells` is the list it answers, reachable under `[sessionListId, "session", "list"]`.
 */
export const sessionListProgram = (options: SessionListSpellOptions = {}): AnyProgram =>
	({
		id: sessionListId,
		label: "AI agent sessions",
		core: defineMachine<SessionListState, SessionListMsg, Cmd<never>, never, unknown>({
			init: (loaded) => [loaded ?? {}, []],
			update: {opened: (state) => [state, []]},
		}),
		ports: {},
		renderer: SESSION_LIST_WINDOW_REF,
		spells: [sessionListSpell(options)],
		handlers: {},
		capabilities: [{family: "filesystem", detail: "every registered backend's session store"}],
		identity: {
			package: "@kampus/tuval",
			program: "ai-agent-sessions",
			version: SESSION_LIST_VERSION,
			digest: "sha256:ai-agent-sessions",
		},
		placement: {host: "local"},
	}) satisfies Program<SessionListState, SessionListMsg, Cmd<never>, never, unknown, never, never>;
