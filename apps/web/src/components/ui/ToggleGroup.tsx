import {Toggle} from "@base-ui/react/toggle";
import {ToggleGroup as BaseToggleGroup} from "@base-ui/react/toggle-group";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./ToggleGroup.css";

const styles = bem("kp-toggle-group", []);

export type ToggleVariant = "pill" | "segmented" | "square" | "swatch";

export function Root({
	variant = "pill",
	className = "",
	children,
	...rest
}: React.ComponentProps<typeof BaseToggleGroup> & {
	variant?: ToggleVariant;
}) {
	const variantCls = variant === "pill" ? "" : `kp-toggle-group--${variant}`;
	return (
		<BaseToggleGroup className={`${styles.root} ${variantCls} ${className}`.trim()} {...rest}>
			{children}
		</BaseToggleGroup>
	);
}

export function Item({
	className = "",
	style,
	swatchColor,
	children,
	...rest
}: React.ComponentProps<typeof Toggle> & {
	swatchColor?: string;
}) {
	// `--swatch-color` is a CSS custom property; React 19's `CSSProperties` only
	// admits them via the `--*` index signature declared in `react-css-vars.d.ts`.
	// base-ui's `style` may be a function of the toggle state, so inject the var
	// by composing over whatever `style` resolves to for the given state.
	type StyleProp = React.ComponentProps<typeof Toggle>["style"];
	const swatchVar: React.CSSProperties | undefined = swatchColor
		? {"--swatch-color": swatchColor}
		: undefined;
	const mergedStyle: StyleProp = !swatchVar
		? style
		: typeof style === "function"
			? (state) => ({...style(state), ...swatchVar})
			: {...style, ...swatchVar};
	return (
		<Toggle className={`kp-toggle ${className}`.trim()} style={mergedStyle} {...rest}>
			{children}
		</Toggle>
	);
}

export const ToggleGroup = {Root, Item};
