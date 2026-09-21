import {type RefObject, useEffect, useRef} from "react";
import "./stickyChrome.css";

/**
 * The sticky chrome stack — the bars pinned to the top edge of the viewport that a page scrolls
 * under: the topbar first, then the subnav resting on it.
 *
 * A stylesheet can pin a bar but it cannot read one, and both offsets this stack needs are
 * another element's rendered height. `.kp-subnav`'s `top` has to equal the topbar's height, and
 * at 640px and below the topbar wraps search onto a second row — so that height is not
 * `var(--topbar-h)`, and it is no other value a rule could name either. Same for the scroll
 * anchor: it has to clear both bars, and the subnav's own height changes when it wraps.
 *
 * So each bar publishes its measured height onto the document root and `stickyChrome.css`
 * composes them. The measurement is a standing observation rather than a reading taken once:
 * a `ResizeObserver` on the bar re-publishes on every change to its box, which is the one
 * mechanism that covers wrapping, viewport resize, text zoom and a changed root font size without
 * enumerating them — and an offset that went stale after any of those is the defect the founder's
 * ruling on #7730 names.
 */

/**
 * The bars, and the property each one publishes to. A closed map rather than a property-name
 * parameter: these two names are a contract with `stickyChrome.css`, and a caller that could pass
 * its own string could publish a height nothing reads.
 */
const MEASURED_HEIGHT_PROPERTY = {
	topbar: "--kp-topbar-measured-h",
	subnav: "--kp-subnav-measured-h",
} as const;

export type StickyChromeBar = keyof typeof MEASURED_HEIGHT_PROPERTY;

/**
 * Publishes this bar's measured height for as long as it is mounted. Attach the returned ref to
 * the bar's own root element — the one the sticky rule targets, so the height measured is the
 * height that covers the viewport edge.
 */
export function useStickyChromeHeight<T extends HTMLElement>(
	bar: StickyChromeBar,
): RefObject<T | null> {
	const ref = useRef<T>(null);

	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const property = MEASURED_HEIGHT_PROPERTY[bar];
		const root = document.documentElement;
		// `getBoundingClientRect` over `offsetHeight`: it is the border box in fractional CSS
		// pixels, and a bar rounded to a whole pixel leaves a hairline of the topbar's own
		// background showing between the two.
		const publish = () => {
			root.style.setProperty(property, `${element.getBoundingClientRect().height}px`);
		};

		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(element);
		return () => {
			observer.disconnect();
			// The bar is gone, so its height is gone with it. Leaving the last measurement
			// standing would offset a page that no longer carries this bar; removing the
			// property hands the ref back to the stylesheet's own default.
			root.style.removeProperty(property);
		};
	}, [bar]);

	return ref;
}
