/**
 * Browsers bind ⌘/Ctrl+K to the address bar, so the Topbar's `<kbd>⌘K</kbd>` hint is a
 * dead label unless this predicate backs it. Keep the two together.
 */
export function isSearchShortcut(e: {key: string; metaKey: boolean; ctrlKey: boolean}): boolean {
	return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}
