/**
 * A textarea does not submit its form on ⌘/Ctrl+Enter natively, so the composer's footer
 * hint is a dead label unless this backs it. Keep the two together.
 */
import type {KeyboardEvent} from "react";

export function isSubmitShortcut(e: {key: string; metaKey: boolean; ctrlKey: boolean}): boolean {
	return (e.metaKey || e.ctrlKey) && e.key === "Enter";
}

/**
 * `requestSubmit()` routes through the form's `onSubmit` so validation and the in-flight
 * guard run exactly as on a button click. It is no double-submit guard on its own: the
 * form's `onSubmit` owns that check.
 */
export function submitOnCmdEnter(e: KeyboardEvent<HTMLTextAreaElement>): void {
	if (!isSubmitShortcut(e)) return;
	e.preventDefault();
	e.currentTarget.form?.requestSubmit();
}
