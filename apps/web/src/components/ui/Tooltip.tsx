import {Tooltip as MantiTooltip, type TooltipProps as MantiTooltipProps} from "@manti-ui/react";
import type * as React from "react";
import "./Tooltip.css";

/**
 * @component TooltipProvider
 * @whenToUse Compatibility-only no-op for the former application-level provider.
 *   Manti Tooltip needs no provider; new code should not add another provider.
 * @slot children The application subtree, returned unchanged.
 */
export function Provider({children}: {children: React.ReactNode}) {
	return <>{children}</>;
}

/**
 * @component Tooltip
 * @whenToUse The Manti-backed hover/focus hint for short supplementary text.
 *   Never place essential information solely in a tooltip.
 * @slot children The trigger content wrapped by Manti's inline trigger.
 */
export function Tooltip({className = "", ...rest}: MantiTooltipProps) {
	return <MantiTooltip className={`kp-tooltip ${className}`.trim()} {...rest} />;
}
