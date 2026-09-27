/**
 * What the desk's Pi window proofs build their states from: the transcript projection, the item
 * fold and the two refusal translations, so a proof page paints what the live path would.
 *
 * A testing door and nothing more. These are the layer's internals, and `../ai-agent/index.ts`
 * keeps them out of the public entry; the proofs live in the desk app because they paint under the
 * desk's own stylesheet order.
 */

export {itemsOf} from "../ai-agent/items.ts";
export {startErrorOf} from "../ai-agent/refusals.ts";
export {connectionRefusalOf} from "../client/refusals.ts";
export {projectTranscript, type SourceMessage} from "../server/transcript.ts";
