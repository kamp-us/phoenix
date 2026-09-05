/**
 * The jsdom gaps React Flow needs on top of the shell surface's own shims.
 *
 * `../../../shell/ui/dom.testing.ts` already fires a measuring `ResizeObserver` and gives every
 * element a box, which is most of it. React Flow adds two more: it reads the viewport's transform
 * through `DOMMatrixReadOnly`, and its edge renderer calls `getBBox` on the SVG path — neither
 * exists in jsdom, and both throw rather than degrade. React Flow's own testing guide names this
 * exact set (https://reactflow.dev/learn/advanced-use/testing).
 */

import {installDomShims} from "../../../shell/ui/dom.testing.ts";

class MatrixStub {
	readonly m22 = 1;
}

export const installEngineViewDomShims = (): void => {
	installDomShims();
	const scope = globalThis as Record<string, unknown>;
	scope.DOMMatrixReadOnly ??= MatrixStub;
	Object.defineProperty(SVGElement.prototype, "getBBox", {
		configurable: true,
		writable: true,
		value: () => ({x: 0, y: 0, width: 0, height: 0}),
	});
	// React Flow's connection machinery hit-tests the pointer through `elementFromPoint`, which jsdom
	// does not implement at all. `null` is the honest answer under a synthetic drag: nothing is there.
	Object.defineProperty(Document.prototype, "elementFromPoint", {
		configurable: true,
		writable: true,
		value: () => null,
	});
};
