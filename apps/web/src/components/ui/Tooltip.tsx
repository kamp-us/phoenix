import {Tooltip as BaseTooltip} from "@base-ui/react/tooltip";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Tooltip.css";

const styles = bem("kp-tooltip", ["positioner", "popup"]);

export const Provider = BaseTooltip.Provider;

export function Tooltip({
	content,
	children,
	side = "top",
	defaultOpen,
}: {
	content: React.ReactNode;
	children: React.ReactNode;
	side?: "top" | "right" | "bottom" | "left";
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
