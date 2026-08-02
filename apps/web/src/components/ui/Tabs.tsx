import "./Tabs.css";

/**
 * @component Tabs
 * @whenToUse The Manti-backed sibling-view switcher. Declare each trigger and
 *   panel through `items`; use line, pill or soft appearance without hand-wiring
 *   tab roles and selection state.
 * @slot items Tab labels and their corresponding panel content.
 */
export type {TabItem, TabsProps} from "@manti-ui/react";
export {Tabs} from "@manti-ui/react";
export type TabsVariant = NonNullable<import("@manti-ui/react").TabsProps["variant"]>;
