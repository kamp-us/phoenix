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
	}
>(function Button(
	{variant = "secondary", size = "md", block, className = "", children, type = "button", ...rest},
	ref,
) {
	const cls = [
		"kp-btn",
		`kp-btn--${variant}`,
		size !== "md" ? `kp-btn--${size}` : "",
		block ? "kp-btn--block" : "",
		className,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<button ref={ref} type={type} className={cls} {...rest}>
			{children}
		</button>
	);
});
