/**
 * The restore rules for any agent program, as a caller imports them: the checkpoint's field set,
 * the resume Msgs a spawner dispatches, and the parse boundary the machine's `init` applies.
 *
 * `restoreSession` is `../core/state.ts`'s `restore` under the name this side reads it by. It
 * lives in the core because it is the machine's own `init` branch and the core's import closure
 * (`../core/boundary.unit.test.ts`) admits no sibling directory; re-exporting it here keeps one
 * address for "what happens to a saved session", with one implementation behind it.
 */

export {restore as restoreSession} from "../core/index.ts";
export {type CheckpointField, checkpointFields, resumeMessages} from "./checkpoint.ts";
