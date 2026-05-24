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
	const mergedStyle = swatchColor ? {...style, ["--swatch-color" as any]: swatchColor} : style;
	return (
		<Toggle className={`kp-toggle ${className}`.trim()} style={mergedStyle} {...rest}>
			{children}
		</Toggle>
	);
}

export const ToggleGroup = {Root, Item};
