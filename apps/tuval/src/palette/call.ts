/**
 * The two pure translations between the palette and the wire: a read line into the one page-to-kernel
 * message, and a refused reply into the sentence under the input.
 *
 * A spell call is the only thing the page sends (`../protocol/messages.ts`, #7617 R1.3), so this is
 * the whole outbound surface of the palette.
 */

import type {SpellCallDraft} from "../commands/parse/parse.ts";
import type {WindowId} from "../protocol/ids.ts";
import {CallId} from "../protocol/ids.ts";
import type {SpellFailure} from "../protocol/messages.ts";
import {PROTOCOL_VERSION, SpellCall} from "../protocol/messages.ts";

/** How a correlation id is minted. The palette's default is the platform's; a test hands its own. */
export type MintCallId = () => string;

export const randomCallId: MintCallId = () => globalThis.crypto.randomUUID();

/**
 * The call a complete line makes. The window is the opener's — scope comes from focus, never from
 * where the palette sits (the founder's 2026-09-04 correction on #7643) — and the kernel resolves
 * the process from it, so the page never names one (#7617 R2.2).
 */
export const spellCallFor = (
	draft: SpellCallDraft,
	window: WindowId | undefined,
	mint: MintCallId = randomCallId,
): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make(mint()),
		path: draft.path,
		args: draft.args,
		...(window === undefined ? {} : {window}),
	});

/**
 * A refusal as one line: the kernel's own message, with the spell it is about and what the argument
 * should have been when the failure carries them. The kernel's words are never paraphrased — a page
 * that rewrites a refusal is a page that can describe a failure that did not happen.
 */
export const failureLine = (failure: SpellFailure): string => {
	const where = failure.path === undefined ? "" : `${failure.path.join(" ")}: `;
	const expected = failure.expected === undefined ? "" : ` (expected ${failure.expected})`;
	const suggestion =
		failure.didYouMean === undefined ? "" : ` — did you mean ${failure.didYouMean}?`;
	return `${where}${failure.message}${expected}${suggestion}`;
};
