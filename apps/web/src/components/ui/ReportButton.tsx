import * as React from "react";
import {useT} from "../../i18n";
import {Button} from "./Button";

export type ReportOutcome = "reported" | "already" | "redirected" | "error";

export interface ReportButtonProps {
	/** The button never calls the report mutation itself; the page's callback does. */
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
	const t = useT();
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

	const label = t(
		state === "reported"
			? "ui.report.reported"
			: state === "already"
				? "ui.report.already"
				: "ui.report.action",
	);

	return (
		<Button
			type="button"
			variant="link"
			size="sm"
			className={className}
			onClick={onClick}
			disabled={state === "busy" || done}
			loading={state === "busy"}
			aria-disabled={done}
			data-testid={testId}
			data-reported={done ? "" : undefined}
		>
			{label}
		</Button>
	);
}
