import * as React from "react";

/**
 * Shared `bildir` (report) button — presentation + inline confirmation only.
 * The page passes `onReport`, which performs the actual `report.submit` (plus the
 * signed-out auth redirect) and returns the outcome; the button owns the in-flight
 * lock and the visible "bildirildi" / "zaten bildirildi" feedback. Reused by every
 * report surface (pano post/comment, sözlük definition), so no page-specific report
 * logic lives in the shared content components.
 */

export type ReportOutcome = "reported" | "already" | "redirected" | "error";

export interface ReportButtonProps {
	/** Performs the report and returns the outcome; the button never calls the mutation itself. */
	onReport: () => Promise<ReportOutcome>;
	testId?: string;
	className?: string;
}

/**
 * @component ReportButton
 * @whenToUse The shared bildir (report) control. Reach for it on any reportable item
 *   (pano post/comment, sözlük definition) — pass `onReport` to perform the mutation
 *   and it owns the in-flight lock plus the bildirildi/zaten bildirildi feedback,
 *   locking once confirmed. Don't hand-roll per-page report logic.
 * @slot none Renders its own label; no children slot.
 */
export function ReportButton({onReport, testId, className}: ReportButtonProps) {
	const [state, setState] = React.useState<"idle" | "busy" | "reported" | "already">("idle");

	// Once a target reads as reported it stays that way for the session — re-clicking
	// a confirmed report is pointless, so the button locks into its feedback state.
	const done = state === "reported" || state === "already";

	async function onClick() {
		if (state === "busy" || done) return;
		setState("busy");
		const outcome = await onReport();
		// `redirected`/`error` leave the button clickable: the signed-out user is
		// navigating away, and a transient error should be retryable.
		setState(outcome === "reported" ? "reported" : outcome === "already" ? "already" : "idle");
	}

	const label =
		state === "reported" ? "bildirildi" : state === "already" ? "zaten bildirildi" : "bildir";

	return (
		<button
			type="button"
			className={className}
			onClick={onClick}
			disabled={state === "busy" || done}
			aria-disabled={done}
			data-testid={testId}
			data-reported={done ? "" : undefined}
		>
			{label}
		</button>
	);
}
