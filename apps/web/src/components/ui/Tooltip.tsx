import {Tooltip as BaseTooltip} from "@base-ui/react/tooltip";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Tooltip.css";

const styles = bem("kp-tooltip", ["popup"]);

export const Provider = BaseTooltip.Provider;

export function Tooltip({
	content,
	children,
	side = "top",
}: {
	content: React.ReactNode;
	children: React.ReactNode;
	side?: "top" | "right" | "bottom" | "left";
}) {
	return (
		<BaseTooltip.Root>
			<BaseTooltip.Trigger render={<span />}>{children}</BaseTooltip.Trigger>
			<BaseTooltip.Portal>
				<BaseTooltip.Positioner side={side} sideOffset={6}>
					<BaseTooltip.Popup className={styles.popup}>{content}</BaseTooltip.Popup>
				</BaseTooltip.Positioner>
			</BaseTooltip.Portal>
		</BaseTooltip.Root>
	);
}
