import {Menu as BaseMenu} from "@base-ui/react/menu";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Menu.css";

const styles = bem("kp-menu", [
	"positioner",
	"popup",
	"item",
	"itemDanger",
	"separator",
	"shortcut",
]);

export const Root = BaseMenu.Root;
export const Trigger = BaseMenu.Trigger;

export function Popup({
	children,
	side = "bottom",
	align = "start",
	positionMethod = "fixed",
	...rest
}: {
	children: React.ReactNode;
	/** Which edge of the trigger the popup opens from. */
	side?: "top" | "right" | "bottom" | "left";
	/** Alignment of the popup along that edge. */
	align?: "start" | "center" | "end";
	/** Anchor strategy; `fixed` keeps it attached inside a sticky ancestor (#1640). */
	positionMethod?: "absolute" | "fixed";
}) {
	return (
		<BaseMenu.Portal>
			{/* positionMethod="fixed" resolves the anchor against the trigger's live
			    viewport rect instead of Base UI's default `absolute` strategy, whose
			    offset-parent/scroll conversion detaches the popup from a trigger inside
			    a `position: sticky` ancestor (the topbar/subnav nav stack) — #1640. */}
			{/* The z-index lives on the Positioner, not the Popup: the Positioner is the
			    `position: fixed` portal-root element, so an explicit z-index there both
			    establishes a stacking context and ranks it above the sticky Subnav
			    (`.kp-subnav`, z-index:49). The inner Popup is `position: static`, where a
			    z-index is inert — so styling z-index on it never escaped the Subnav's
			    layer (#2041). */}
			<BaseMenu.Positioner
				className={styles.positioner}
				side={side}
				align={align}
				sideOffset={4}
				positionMethod={positionMethod}
			>
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
	/** Destructive styling for a delete/remove item. */
	danger?: boolean;
	/** Keyboard-shortcut hint rendered trailing the label. */
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

/**
 * @component Menu
 * @whenToUse The dropdown-menu compound (base-ui). Compose from its parts for any
 *   contextual action list or overflow menu; each `Item`'s accessible name comes
 *   from its text child. Its z-index/anchor handling is tuned for the sticky nav
 *   stack (#1640/#2041) — reach for it rather than a hand-built popup.
 * @slot Root The open/close state provider wrapping the trigger + popup.
 * @slot Trigger The element that opens the menu.
 * @slot Popup The portalled, positioned popup surface holding the items.
 * @slot Item A menu action; supports `danger` and a `shortcut` hint.
 * @slot Separator A divider rule between item groups.
 */
export const Menu = {Root, Trigger, Popup, Item, Separator};
