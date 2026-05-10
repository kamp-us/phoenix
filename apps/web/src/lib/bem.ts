/**
 * Maps a flat list of element names to BEM class strings under a single block.
 *
 *   bem('kp-dialog', ['popup', 'head'])
 *     → { root: 'kp-dialog', popup: 'kp-dialog__popup', head: 'kp-dialog__head' }
 *
 * Component CSS files use literal BEM class names (`.kp-dialog__popup`) and are
 * imported as side-effect global stylesheets next to each component, so this
 * helper just gives a typed `styles.popup`-style accessor.
 */
export function bem(block: string, elements: string[]): Record<string, string> {
	const out: Record<string, string> = {root: block};
	for (const el of elements) {
		const cls = el.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
		out[el] = `${block}__${cls}`;
	}
	return out;
}
