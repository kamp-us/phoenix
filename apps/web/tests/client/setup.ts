// Per-test DOM teardown for the `client` vitest tier (#1419). Testing Library's
// auto-cleanup only fires when Vitest globals are on; this project keeps explicit
// imports, so unmount-after-each is wired here instead, keeping each `*.test.tsx`
// isolated.
import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

// Manti'nin Zag/Floating UI tabanlı katmanları gerçek tarayıcıda bulunan bu iki
// API'yi kullanır. jsdom bunları sağlamadığı için istemci test ortamında davranışı
// etkisiz ama arayüzü doğru iki küçük uyumluluk katmanı kuruyoruz.
if (typeof globalThis.PointerEvent === "undefined") {
	class PointerEventShim extends MouseEvent {
		readonly pointerType: string;

		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.pointerType = init.pointerType ?? "";
		}
	}
	globalThis.PointerEvent = PointerEventShim as typeof PointerEvent;
}

if (typeof globalThis.ResizeObserver === "undefined") {
	class ResizeObserverShim implements ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	globalThis.ResizeObserver = ResizeObserverShim;
}

afterEach(cleanup);
