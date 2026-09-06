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
 * The checkpoint's field set, at the address this side reads it by. It lives in `../core/state.ts`
 * because the defaults fill on the load path walks it and the core may import no sibling directory;
 * re-exporting it here keeps one address, exactly as `../restore/index.ts` does for `restore`.
 */
export {type CheckpointField, checkpointFields} from "../core/index.ts";

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
