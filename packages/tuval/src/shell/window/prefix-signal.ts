/**
 * The one desk-level key fact a window renderer needs, published on the DOM instead of passed.
 *
 * It cannot be passed: `./host.ts` carries a dispatch and a view slot and no key channel, and the
 * two rendering slices may not import each other (`../ui/boundary.unit.test.ts`). So the desk marks
 * its own root while the shell's prefix is armed and a region that would otherwise take a key reads
 * that mark off the key's own target.
 *
 * Armed means tmux's rule is in force: the next key is the shell's from any focus (#8270), so every
 * region inside the desk stands down until the sequence resolves.
 */

export const PREFIX_ARMED_ATTRIBUTE = "data-prefix-armed";

/** Present only while armed, so presence is the whole answer and no value has to be compared. */
const PREFIX_ARMED_SELECTOR = `[${PREFIX_ARMED_ATTRIBUTE}]`;

/** Is the desk this event landed in holding an armed prefix? `false` outside a desk entirely. */
export const prefixArmedAround = (target: EventTarget | null | undefined): boolean => {
	if (target === null || target === undefined || typeof target !== "object") return false;
	const element = target as {closest?: unknown};
	if (typeof element.closest !== "function") return false;
	return (element as Element).closest(PREFIX_ARMED_SELECTOR) !== null;
};
