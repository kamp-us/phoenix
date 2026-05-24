import {Tabs as BaseTabs} from "@base-ui/react/tabs";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Tabs.css";

const styles = bem("kp-tabs", ["list", "tab", "panel"]);

export function Root({
	variant = "underline",
	className = "",
	children,
	...rest
}: React.ComponentProps<typeof BaseTabs.Root> & {
	variant?: "underline" | "pill";
}) {
	const cls = `${styles.root} ${variant === "pill" ? "kp-tabs--pill" : ""} ${className}`.trim();
	return (
		<BaseTabs.Root className={cls} {...rest}>
			{children}
		</BaseTabs.Root>
	);
}

export function List({children, ...rest}: React.ComponentProps<typeof BaseTabs.List>) {
	return (
		<BaseTabs.List className={styles.list} {...rest}>
			{children}
		</BaseTabs.List>
	);
}

export function Tab({children, ...rest}: React.ComponentProps<typeof BaseTabs.Tab>) {
	return (
		<BaseTabs.Tab className={styles.tab} {...rest}>
			{children}
		</BaseTabs.Tab>
	);
}

export function Panel({children, ...rest}: React.ComponentProps<typeof BaseTabs.Panel>) {
	return (
		<BaseTabs.Panel className={styles.panel} {...rest}>
			{children}
		</BaseTabs.Panel>
	);
}

export const Tabs = {Root, List, Tab, Panel};
