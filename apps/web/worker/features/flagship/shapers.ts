/**
 * Flagship admin wire-entity shapers (#2741). The `{__typename, …}` `FlagState` literal is
 * built here (the pasaport-shapers idiom) so the `flags.state` roll-up and the
 * `flag.setOverride` ack produce one identical shape.
 */
import type {FlagStateEntity} from "./views.ts";

/**
 * Build the `FlagState` row for one declared flag. `effective` is the override-applied value
 * a real gate would read right now (from `Flags.getBoolean`, which the runtime-override wrapper
 * short-circuits); `overridden` is whether an active override forces it (distinguishing a
 * forced-`false` from a real-evaluation `false`). `id` === the flag key (the client
 * normalization key).
 */
export const toFlagState = (input: {
	readonly key: string;
	readonly defaultValue: boolean;
	readonly effective: boolean;
	readonly overridden: boolean;
}): FlagStateEntity => ({
	__typename: "FlagState",
	id: input.key,
	key: input.key,
	defaultValue: input.defaultValue,
	effective: input.effective,
	overridden: input.overridden,
});
