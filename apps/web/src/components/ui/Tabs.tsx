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
	/** Visual style of the tab list: `underline` (default) or `pill`. */
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

/**
 * @component Tabs
 * @whenToUse The tabbed-panels compound (base-ui). Compose from its parts to switch
 *   between sibling views within one region; supports an `underline` or `pill`
 *   `variant`. Reach for it over hand-wired show/hide so keyboard + aria roles come
 *   for free.
 * @slot Root The selection-state provider wrapping the list + panels.
 * @slot List The tab strip holding the `Tab` triggers.
 * @slot Tab A single tab trigger; its text child is its accessible name.
 * @slot Panel The content region shown for the matching tab.
 */
export const Tabs = {Root, List, Tab, Panel};
