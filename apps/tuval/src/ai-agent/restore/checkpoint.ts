/**
 * What an agent session checkpoints, and what a spawner does with one that came back.
 *
 * There is no second persistence path: durability is native to the kernel (#7514), so the
 * checkpoint is the core machine's own state, written by the `Store` a process opens and read
 * back by `restore` in `../core/state.ts`. This module is the two rules around that — which
 * fields the state is allowed to be made of, and what a caller dispatches once a restored process
 * is live — and they are generic: nothing here names Pi, Claude or the scripted layer.
 */

import type {AiAgentSessionMsg, AiAgentSessionState} from "../core/index.ts";

/**
 * Every field one checkpoint carries. Two things read it: the field-set test, which fails when a
 * new field lands here without anyone deciding it survives a restart, and a reader asking what a
 * saved session is made of without walking the machine.
 *
 * Nothing wire-shaped is in it. Each entry is plain JSON by construction — the type-level proof is
 * `../core/boundary.unit.test.ts`, which reds when a service, a stream, an Effect or a closure
 * reaches any depth of the state — so the whole checkpoint round-trips through `JSON`.
 */
export const checkpointFields = [
	"phase",
	"sessionId",
	"connection",
	"cwd",
	"transcript",
	"interrupted",
	"usage",
	"permissions",
	"modes",
	"models",
	"lastPrompt",
	"lastPage",
	"failure",
] as const satisfies ReadonlyArray<keyof AiAgentSessionState>;

export type CheckpointField = (typeof checkpointFields)[number];

/**
 * What a spawner dispatches into a process the kernel just brought back.
 *
 * It is a Msg rather than an init Cmd because Demlik refuses a rehydrating `init` that emits any:
 * that branch is the migration/parse boundary, and the sanctioned route for a state-conditional
 * resume is "a Msg dispatched once from the host after the process is live" (`@demlik/tea` 0.12
 * `runtime-types.ts`, the "TEA contract violation" guard).
 *
 * A `gone` session was refused on its last resume, so it gets nothing: opening anything in its
 * place is the silent fresh session #7514 refuses. Everything holding an id reconnects, and the
 * machine turns that into `start({cwd, resume: sessionId})` against a freshly built layer (ruling
 * 4, #7570) — never a new session, and never a re-sent prompt.
 *
 * A checkpoint with no id was never opened at all — the process was written down between its spawn
 * and its first `started`. There is nothing to reconnect to and no id a fresh open could duplicate,
 * so it takes the same route a fresh spawn takes (#7925). Without this it comes back wedged: the
 * boot Cmd is the fresh `init`'s alone, and a rehydrating one may emit none.
 */
export const resumeMessages = (state: AiAgentSessionState): ReadonlyArray<AiAgentSessionMsg> => {
	if (state.phase === "gone") return [];
	return state.sessionId === null
		? [{type: "start", cwd: state.cwd, resume: null}]
		: [{type: "reconnect"}];
};
