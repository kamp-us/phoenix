import * as React from "react";
import "./CountToggle.css";

/**
 * The count-pill toggle primitive (#2163, pillar cohesiveness; epic #2168). A
 * pressable pill carrying an icon/label and an optional aggregate count, its
 * on/off state exposed via `aria-pressed` and carried visually by the accent
 * tint (never color alone — the pressed state is in the ARIA + the shape). The
 * reaction bar's per-emoji buttons are the canonical instance; this extracts the
 * pill so the shape is built once instead of re-assembled per surface. Role
 * tokens only; the 24px floor is the WCAG 2.5.8 minimum target size (#2166).
 */
export interface CountToggleProps
	extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
	/** On/off state → `aria-pressed` + the accent-tinted pressed styling. */
	pressed?: boolean;
	/** Aggregate count rendered after the icon/label. Hidden when 0 unless `showZero`. */
	count?: number;
	/** Render a `0` count instead of hiding it. */
	showZero?: boolean;
	/** Leading icon/glyph (decorative — name the control via `aria-label`). */
	icon?: React.ReactNode;
	children?: React.ReactNode;
	/** Test id for the count element (the label lives on the button's own props). */
	countTestId?: string;
}

export const CountToggle = React.forwardRef<HTMLButtonElement, CountToggleProps>(
	function CountToggle(
		{
			pressed,
			count,
			showZero = false,
			icon,
			children,
			countTestId,
			className = "",
			type = "button",
			...rest
		},
		ref,
	) {
		const showCount = count != null && (showZero || count > 0);
		return (
			<button
				ref={ref}
				type={type}
				className={`kp-count-toggle ${className}`.trim()}
				aria-pressed={pressed}
				{...rest}
			>
				{icon}
				{children}
				{showCount ? (
					<span className="kp-count-toggle__count" data-testid={countTestId}>
						{count}
					</span>
				) : null}
			</button>
		);
	},
);
