import * as React from "react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export const Button = React.forwardRef<
	HTMLButtonElement,
	React.ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: ButtonVariant;
		size?: ButtonSize;
		block?: boolean;
		/** Toggle/active state → `aria-pressed` + the accent-tinted pressed styling. */
		pressed?: boolean;
		/** Leading icon/glyph (decorative — the label is the button's own children). */
		icon?: React.ReactNode;
		/** In-flight: shows a spinner, marks `aria-busy`, and disables interaction. */
		loading?: boolean;
	}
>(function Button(
	{
		variant = "secondary",
		size = "md",
		block,
		pressed,
		icon,
		loading = false,
		disabled,
		className = "",
		children,
		type = "button",
		...rest
	},
	ref,
) {
	const cls = [
		"kp-btn",
		`kp-btn--${variant}`,
		size !== "md" ? `kp-btn--${size}` : "",
		block ? "kp-btn--block" : "",
		pressed ? "kp-btn--pressed" : "",
		loading ? "kp-btn--loading" : "",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button
			ref={ref}
			type={type}
			className={cls}
			aria-pressed={pressed}
			aria-busy={loading || undefined}
			disabled={disabled || loading}
			{...rest}
		>
			{loading ? (
				<span className="kp-btn__spinner" aria-hidden="true" />
			) : icon ? (
				<span className="kp-btn__icon" aria-hidden="true">
					{icon}
				</span>
			) : null}
			{children}
		</button>
	);
});
