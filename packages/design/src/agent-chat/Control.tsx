import type {LucideIcon} from "lucide-react";
import {Button, type ButtonProps} from "../Button";
import {Icon, type IconSize} from "./Icon";

export interface AgentChatControlProps
	extends Omit<ButtonProps, "icon" | "variant" | "size" | "type"> {
	readonly icon: LucideIcon;
	readonly iconSize?: IconSize;
}

/**
 * The one primitive every composer control is built from: a ghost button carrying a glyph, with
 * whatever label it has as its children. `variant` and `size` are the primitive's, not the call
 * site's, so a row of controls cannot drift apart one button at a time.
 */
export function AgentChatControl({icon, iconSize = 16, children, ...rest}: AgentChatControlProps) {
	return (
		<Button {...rest} type="button" variant="tertiary" size="sm">
			<Icon icon={icon} size={iconSize} />
			{children}
		</Button>
	);
}
