/**
 * The seam the desk sends a key through, and the reader that turns the kernel's acknowledgement
 * back into an answer the surface can act on.
 *
 * There is one router and it is the kernel's (#8274, ADR 0353). The page does not route a key and
 * then send it as well: it sends the key, waits, and does what the answer says. So a key the kernel
 * never applied — a socket that went in flight — forwards nothing, and there is no second copy of
 * the prefix on the page to drift out of step with the first.
 */

import type {ShellState} from "../core/index.ts";
import {isShellState} from "../core/index.ts";
import type {Key} from "../keys/index.ts";
import type {DispatchResult} from "../window/host.ts";

/**
 * What the kernel answered about one key. The three `KeyOutcome` arms are the kernel's; `Refused`
 * is the page's own and means no answer arrived — the process is gone, the socket dropped, or the
 * state on the ack is not this press's. Nothing is forwarded on it, deliberately: a page that
 * guessed here would be routing.
 */
export type KeyReply = NonNullable<ShellState["lastPress"]>["outcome"] | {readonly _tag: "Refused"};

export const refused: KeyReply = {_tag: "Refused"};

/** How a desk sends one key to the kernel and hears back. */
export type KeyPress = (key: Key) => Promise<KeyReply>;

/**
 * The answer to `pressId` in a shell state, or `Refused`. The stamp is checked rather than assumed:
 * a second page attached to the same shell writes `lastPress` too, and reading its answer as this
 * page's would forward a key nobody here pressed.
 */
export const replyIn = (pressId: string, state: unknown): KeyReply =>
	isShellState(state) && state.lastPress !== undefined && state.lastPress.pressId === pressId
		? state.lastPress.outcome
		: refused;

/** The same, off a dispatch acknowledgement: `Delivered` carrying the state the Msg left behind. */
export const replyOf = (pressId: string, result: DispatchResult): KeyReply =>
	result._tag === "Delivered" && result.view !== undefined
		? replyIn(pressId, result.view.state)
		: refused;
