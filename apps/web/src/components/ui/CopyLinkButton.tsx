import * as React from "react";

/**
 * Shared `paylaş` (share/copy-link) button — presentation + inline confirmation only.
 * The page passes the item's canonical **path** (`/pano/:id`, `/sozluk/:slug`, or a
 * comment-anchor `/pano/:id#comment-<id>`); the button resolves it to an absolute URL
 * and copies it to the clipboard, locking into visible "kopyalandı" feedback (or
 * "kopyalanamadı" when the clipboard write is denied — insecure context, permission).
 * Where the platform offers a native share sheet (`navigator.share`, mobile/PWA) it
 * invokes that instead. Reused by every share surface (pano post/comment, sözlük
 * definition), so no page-specific link logic lives in the shared content components.
 */

export type ShareOutcome = "shared" | "copied" | "error";

function absoluteUrl(path: string): string {
	return new URL(path, window.location.origin).toString();
}

async function shareOrCopy(url: string): Promise<ShareOutcome> {
	// A native share sheet is the better affordance on the surfaces that have one
	// (mobile/PWA); a desktop browser falls through to the clipboard. `canShare`
	// guards against the URL-less `navigator.share` stub some browsers expose.
	if (typeof navigator.share === "function" && navigator.canShare?.({url})) {
		try {
			await navigator.share({url});
			return "shared";
		} catch (error) {
			// An `AbortError` is the user dismissing the sheet — not a failure, and not
			// something to fall back to a silent clipboard write for.
			if (error instanceof DOMException && error.name === "AbortError") return "shared";
		}
	}
	// `navigator.clipboard` is itself absent in an insecure context (non-localhost
	// HTTP) — a missing API is a failure to surface, not a thrown write to catch.
	if (!navigator.clipboard) return "error";
	try {
		await navigator.clipboard.writeText(url);
		return "copied";
	} catch {
		return "error";
	}
}

/**
 * The label a {@link CopyLinkButton} shows for each transient feedback state. A
 * `null` outcome (idle) and a `"shared"` (the OS sheet is its own feedback) both
 * fall through to the caller's resting `label`. Pure, so the state→copy mapping is
 * unit-tested without a DOM.
 */
export function shareFeedbackLabel(
	outcome: "copied" | "error" | null,
	restingLabel: string,
): string {
	switch (outcome) {
		case "copied":
			return "kopyalandı";
		case "error":
			return "kopyalanamadı";
		default:
			return restingLabel;
	}
}

export interface CopyLinkButtonProps {
	/** Canonical path of the item, e.g. `/pano/:id` or `/pano/:id#comment-<id>`. */
	path: string;
	label?: string;
	testId?: string;
	className?: string;
}

export function CopyLinkButton({path, label = "paylaş", testId, className}: CopyLinkButtonProps) {
	const [feedback, setFeedback] = React.useState<"copied" | "error" | null>(null);
	const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	React.useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	async function onClick() {
		const outcome = await shareOrCopy(absoluteUrl(path));
		// A native share leaves the label as-is (the OS sheet is its own feedback); a
		// clipboard write flashes its outcome — "kopyalandı" on success, "kopyalanamadı"
		// on a denied/absent clipboard — for two seconds, then resets.
		if (outcome === "shared") return;
		setFeedback(outcome === "copied" ? "copied" : "error");
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setFeedback(null), 2000);
	}

	return (
		<button
			type="button"
			className={className}
			onClick={onClick}
			data-testid={testId}
			data-copied={feedback === "copied" ? "" : undefined}
			data-copy-error={feedback === "error" ? "" : undefined}
		>
			{shareFeedbackLabel(feedback, label)}
		</button>
	);
}
