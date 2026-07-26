import "./Menu.css";

/**
 * @component Menu
 * @whenToUse The Manti-backed dropdown command list for account and contextual
 *   actions. Describe commands through `items`; use groups and separators for
 *   structure instead of hand-built popup content.
 * @slot trigger The element that opens the menu.
 * @slot items Commands, separators and command groups supplied through `items`.
 */
export type {MenuItem, MenuProps} from "@manti-ui/react";
export {Menu} from "@manti-ui/react";
