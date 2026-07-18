import {Collapsible as BaseCollapsible} from "@base-ui/react/collapsible";
import type * as React from "react";
import {bem} from "../../lib/bem";
import "./Collapsible.css";

const styles = bem("kp-collapsible", ["trigger", "panel"]);

export const Root = BaseCollapsible.Root;

export function Trigger({
	open,
	className = "",
	...rest
}: React.ComponentProps<typeof BaseCollapsible.Trigger> & {
	/** Current open state — drives the +/– glyph and the expand/collapse aria-label. */
	open?: boolean;
}) {
	return (
		<BaseCollapsible.Trigger
			className={`${styles.trigger} ${className}`.trim()}
			aria-label={open ? "Daralt" : "Genişlet"}
			{...rest}
		>
			{open ? "–" : "+"}
		</BaseCollapsible.Trigger>
	);
}

export function Panel({children, ...rest}: React.ComponentProps<typeof BaseCollapsible.Panel>) {
	return (
		<BaseCollapsible.Panel className={styles.panel} {...rest}>
			{children}
		</BaseCollapsible.Panel>
	);
}

/**
 * @component Collapsible
 * @whenToUse The show/hide disclosure compound (base-ui). Compose from its parts to
 *   toggle a region's visibility inline — a "show more" body, an expandable detail.
 *   `Trigger` supplies its own genişlet/daralt aria-label, so reach for it rather
 *   than a hand-wired button + hidden div.
 * @slot Root The open/close state provider wrapping the trigger + panel.
 * @slot Trigger The +/– toggle control that opens/closes the panel.
 * @slot Panel The collapsible content region.
 */
export const Collapsible = {Root, Trigger, Panel};
