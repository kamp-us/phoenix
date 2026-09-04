import * as React from "react";
import {Button, type ButtonProps} from "./Button";
import "./CountToggle.css";

/**
 * The count-pill toggle primitive — see ADR 0162. Pressed state is carried by
 * `aria-pressed` and the shape, never by the accent tint alone; role tokens only,
 * and the 24px floor is the WCAG 2.5.8 minimum target size (#2166).
 *
 * @component CountToggle
 * @whenToUse The pressable count-pill — a reaction/vote/toggle affordance that
 *   carries an aggregate count. Reach for it over a bare toggle button whenever a
 *   count rides alongside the on/off state (the reaction bar is the canonical use).
 * @slot children The visible label; when omitted (icon-only), name the control via
 *   `aria-label` since the icon is decorative.
 * @slot icon Leading decorative glyph rendered before the label/count.
 */
export interface CountToggleProps
	extends Omit<ButtonProps, "children" | "pressed" | "count" | "icon"> {
	pressed?: boolean;
	/** Hidden when 0 unless `showZero`. */
	count?: number;
	showZero?: boolean;
	icon?: React.ReactNode;
	children?: React.ReactNode;
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
		const generatedId = React.useId();
		const id = rest.id ?? `kp-count-toggle-${generatedId.replaceAll(":", "")}`;
		React.useImperativeHandle(ref, () => document.getElementById(id) as HTMLButtonElement, [id]);
		return (
			<Button
				id={id}
				type={type}
				variant="tertiary"
				size="sm"
				className={`kp-count-toggle ${className}`.trim()}
				pressed={pressed}
				{...rest}
			>
				{icon}
				{children}
				{showCount ? (
					<span className="kp-count-toggle__count" data-testid={countTestId}>
						{count}
					</span>
				) : null}
			</Button>
		);
	},
);
