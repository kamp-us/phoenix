import {Tooltip as BaseTooltip} from "@base-ui/react/tooltip";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Tooltip.css";

const styles = bem("kp-tooltip", ["positioner", "popup"]);

/**
 * @component TooltipProvider
 * @whenToUse The tooltip timing/context host (base-ui). Mount it once high in the
 *   tree so grouped tooltips share open/close delays; every `Tooltip` renders under
 *   it. Reach for it at the app/shell level, not per tooltip.
 * @slot children The subtree whose `Tooltip`s share this provider's timing.
 */
export const Provider = BaseTooltip.Provider;

/**
 * @component Tooltip
 * @whenToUse The hover/focus tooltip (base-ui). Wrap a trigger element to attach a
 *   short supplementary hint. It is supplementary only — never put essential
 *   information solely in a tooltip; its z-index is tuned to clear the sticky Subnav
 *   (#2046). Requires a `TooltipProvider` ancestor.
 * @slot children The trigger element the tooltip is attached to.
 */
export function Tooltip({
	content,
	children,
	side = "top",
	defaultOpen,
}: {
	/** The tooltip's content shown in the popup. */
	content: React.ReactNode;
	/** The trigger element the tooltip attaches to. */
	children: React.ReactNode;
	/** Which edge of the trigger the popup opens from. Defaults to `top`. */
	side?: "top" | "right" | "bottom" | "left";
	/** Render open on mount (e.g. for a one-shot coach-mark). */
	defaultOpen?: boolean;
}) {
	return (
		<BaseTooltip.Root defaultOpen={defaultOpen}>
			<BaseTooltip.Trigger render={<span />}>{children}</BaseTooltip.Trigger>
			<BaseTooltip.Portal>
				{/* The z-index lives on the Positioner, not the Popup: the Positioner is the
				    positioned (`position: absolute`) portal-root element, so an explicit z-index
				    there both establishes a stacking context and ranks it above the sticky Subnav
				    (`.kp-subnav`, z-index:49). The inner Popup is `position: static`, where a
				    z-index is inert — so styling z-index on it never escaped the Subnav's
				    layer (#2046, mirror of the Menu fix in #2041/#2044). */}
				<BaseTooltip.Positioner className={styles.positioner} side={side} sideOffset={6}>
					<BaseTooltip.Popup className={styles.popup}>{content}</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
