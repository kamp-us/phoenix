import {Menu as BaseMenu} from "@base-ui/react/menu";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Menu.css";

const styles = bem("kp-menu", ["popup", "item", "itemDanger", "separator", "shortcut"]);

export const Root = BaseMenu.Root;
export const Trigger = BaseMenu.Trigger;

export function Popup({
	children,
	side = "bottom",
	align = "start",
	...rest
}: {
	children: React.ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
}) {
	return (
		<BaseMenu.Portal>
			<BaseMenu.Positioner side={side} align={align} sideOffset={4}>
				<BaseMenu.Popup className={styles.popup} {...rest}>
					{children}
				</BaseMenu.Popup>
			</BaseMenu.Positioner>
		</BaseMenu.Portal>
	);
}

export function Item({
	danger,
	shortcut,
	children,
	...rest
}: React.ComponentProps<typeof BaseMenu.Item> & {
	danger?: boolean;
	shortcut?: string;
}) {
	const cls = danger ? `${styles.item} kp-menu__item--danger` : styles.item;
	return (
		<BaseMenu.Item className={cls} {...rest}>
			<span>{children}</span>
			{shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
		</BaseMenu.Item>
	);
}

export function Separator() {
	return <BaseMenu.Separator className={styles.separator} />;
}

export const Menu = {Root, Trigger, Popup, Item, Separator};
