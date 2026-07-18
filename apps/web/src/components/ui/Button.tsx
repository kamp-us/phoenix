import * as React from "react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/**
 * @component Button
 * @whenToUse The base action control. Reach for `variant="primary"` for the one
 *   promoted action per view, `secondary` for standard actions, `tertiary` for
 *   low-emphasis inline actions, `danger` for destructive ones — the variant scale
 *   and the one-primary-per-view rule are the manifest's, referenced not restated
 *   (see `design-system-manifest.md`). Prefer this over a hand-rolled `<button>`.
 * @slot children The button label — the accessible name comes from it, so an
 *   icon-only button must be named via `aria-label` instead.
 * @slot icon Optional leading decorative glyph; never the accessible name.
 */
export const Button = React.forwardRef<
	HTMLButtonElement,
	React.ButtonHTMLAttributes<HTMLButtonElement> & {
		/** Visual emphasis role: `primary` · `secondary` · `tertiary` · `danger`. */
		variant?: ButtonVariant;
		/** Control size off the density scale (`sm` · `md` · `lg`). */
		size?: ButtonSize;
		/** Stretch to the container's full width. */
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
