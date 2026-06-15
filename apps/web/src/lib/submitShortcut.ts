/**
 * The ⌘/Ctrl+Enter "gönder" shortcut every markdown composer advertises in its
 * footer hint. A `<textarea>` does not submit its form on ⌘/Ctrl+Enter natively,
 * so the hint needs this handler to back it — keep the two together so the
 * affordance and its implementation can't drift apart again.
 */
import type {KeyboardEvent} from "react";

/** Pure predicate: is this a ⌘+Enter (mac) / Ctrl+Enter (elsewhere) keystroke? */
export function isSubmitShortcut(e: {key: string; metaKey: boolean; ctrlKey: boolean}): boolean {
	return (e.metaKey || e.ctrlKey) && e.key === "Enter";
}

/**
 * `onKeyDown` for a composer textarea: ⌘/Ctrl+Enter calls `requestSubmit()` so the
 * keystroke goes through the form's `onSubmit` (validation + in-flight guard) exactly
 * like clicking the submit button. Plain Enter falls through to the textarea's native
 * newline. `requestSubmit()` is no double-submit guard on its own, so the form's
 * `onSubmit` owns the in-flight check; the textarea is also `disabled` while in flight,
 * which stops the keystroke from reaching here at all.
 */
export function submitOnCmdEnter(e: KeyboardEvent<HTMLTextAreaElement>): void {
	if (!isSubmitShortcut(e)) return;
	e.preventDefault();
	e.currentTarget.form?.requestSubmit();
}
