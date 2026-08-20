/**
 * Component CSS files carry literal BEM class names and are imported as side-effect
 * global stylesheets, so this only gives a typed `styles.popup`-style accessor —
 * nothing here scopes or hashes a class name.
 */
export function bem(block: string, elements: string[]): Record<string, string> {
	const out: Record<string, string> = {root: block};
	for (const el of elements) {
		const cls = el.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
		out[el] = `${block}__${cls}`;
	}
	return out;
}
