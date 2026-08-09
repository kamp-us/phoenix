import {
	type ButtonSize,
	type MantiBuiltinVariant,
	Button as MantiButton,
	type ButtonProps as MantiButtonProps,
} from "@manti-ui/react";
import type * as React from "react";
import "./Button.css";

export type {ButtonSize};
export type ButtonVariant = MantiBuiltinVariant | "link";

export interface ButtonProps
	extends Omit<MantiButtonProps, "variant" | "fullWidth" | "leadingIcon" | "aria-pressed"> {
	/** Phoenix intentionally exposes Manti's documented built-in variants. */
	variant?: ButtonVariant;
	/** Phoenix compatibility alias for Manti's `fullWidth`. */
	block?: boolean;
	/** Phoenix compatibility alias for Manti's `leadingIcon`. */
	icon?: React.ReactNode;
	/** Optional toggle state for button-shaped app actions. */
	pressed?: boolean;
}

/**
 * @component Button
 * @whenToUse The Manti-backed base action control. Use `primary` for the promoted
 *   action, `secondary` for standard actions, `tertiary` for low-emphasis actions
 *   and `danger` for destructive actions; prefer it over a hand-rolled button.
 * @slot children The visible label and accessible name.
 * @slot icon Optional leading decorative glyph, mapped to Manti's icon slot.
 */
export function Button({block, icon, pressed, className = "", children, ...rest}: ButtonProps) {
	return (
		<MantiButton
			{...rest}
			fullWidth={block}
			leadingIcon={
				icon ? (
					<span className="kp-btn__icon" aria-hidden="true">
						{icon}
					</span>
				) : undefined
			}
			aria-pressed={pressed}
			className={`kp-btn ${className}`.trim()}
		>
			{children}
		</MantiButton>
	);
}
