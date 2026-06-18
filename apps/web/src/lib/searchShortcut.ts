/**
 * The ⌘/Ctrl+K "ara" shortcut the Topbar advertises with its `<kbd>⌘K</kbd>` hint.
 * Browsers bind ⌘/Ctrl+K to the address bar, so focusing the search input needs this
 * handler to back it — keep the predicate and its Topbar wiring together so the hint
 * and its implementation can't drift apart and leave a dead label again.
 */

/** Pure predicate: is this a ⌘+K (mac) / Ctrl+K (elsewhere) keystroke? */
export function isSearchShortcut(e: {key: string; metaKey: boolean; ctrlKey: boolean}): boolean {
	return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}
