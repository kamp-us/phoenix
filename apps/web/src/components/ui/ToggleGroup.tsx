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
	/** Visual style of the group: `pill` (default) · `segmented` · `square` · `swatch`. */
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
	/** For the `swatch` variant: the color rendered as the item's fill (`--swatch-color`). */
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

/**
 * @component ToggleGroup
 * @whenToUse The single/multi-select toggle set (base-ui). Compose `Root` + `Item`s
 *   for a segmented control, a filter set, or a swatch picker (`variant="swatch"`
 *   with `swatchColor`). Reach for it when a small fixed set of options toggles in
 *   place; for a binary on/off use `Switch`.
 * @slot Root The selection-state provider wrapping the items.
 * @slot Item A single toggle option; text child is its accessible name (or set
 *   `aria-label` for an icon/swatch-only item).
 */
export const ToggleGroup = {Root, Item};
