import * as React from "react";
import {type CatalogKey, useT} from "../../i18n";
import {Button} from "./Button";

export type ShareOutcome = "shared" | "copied" | "error";

function absoluteUrl(path: string): string {
	return new URL(path, window.location.origin).toString();
}

/**
 * Whether to invoke the native share sheet rather than copy to the clipboard. The
 * native branch fires only on a **coarse-pointer** surface (mobile/PWA) that *also*
 * has a usable Web Share API — never on mere API presence, because Safari macOS
 * desktop implements the API yet must copy like every other desktop browser (#1635).
 */
export function shouldUseNativeShare(input: {
	hasShare: boolean;
	canShareUrl: boolean;
	coarsePointer: boolean;
}): boolean {
	return input.coarsePointer && input.hasShare && input.canShareUrl;
}

function coarsePointer(): boolean {
	return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

async function shareOrCopy(url: string): Promise<ShareOutcome> {
	const useNative = shouldUseNativeShare({
		// `canShare` guards against the URL-less `navigator.share` stub some browsers expose.
		hasShare: typeof navigator.share === "function",
		canShareUrl: navigator.canShare?.({url}) ?? false,
		coarsePointer: coarsePointer(),
	});
	if (useNative) {
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

export function shareFeedbackLabelKey(
	outcome: "copied" | "error" | null,
	restingKey: CatalogKey,
): CatalogKey {
	switch (outcome) {
		case "copied":
			return "ui.share.copied";
		case "error":
			return "ui.share.error";
		default:
			return restingKey;
	}
}

export interface CopyLinkButtonProps {
	/** Canonical path of the item, e.g. `/pano/:id` or `/pano/:id#comment-<id>`. */
	path: string;
	/** The resting label's catalog key; defaults to the shared paylaş copy. */
	labelKey?: CatalogKey;
	testId?: string;
	className?: string;
}

/**
 * @component CopyLinkButton
 * @whenToUse The shared paylaş (share/copy-link) control. Reach for it on any
 *   shareable item (pano post/comment, sözlük definition) — pass the canonical
 *   `path` and it resolves the absolute URL, copies it, and flashes inline
 *   kopyalandı/kopyalanamadı feedback (native share sheet only on coarse-pointer
 *   surfaces). Don't hand-roll per-page link logic.
 * @slot none Renders its own label; no children slot.
 */
export function CopyLinkButton({
	path,
	labelKey = "ui.share.label",
	testId,
	className,
}: CopyLinkButtonProps) {
	const t = useT();
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
		// A native share leaves the label as-is: the OS sheet is its own feedback.
		if (outcome === "shared") return;
		setFeedback(outcome === "copied" ? "copied" : "error");
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setFeedback(null), 2000);
	}

	return (
		<Button
			type="button"
			variant="link"
			size="sm"
			className={className}
			onClick={onClick}
			data-testid={testId}
			data-copied={feedback === "copied" ? "" : undefined}
			data-copy-error={feedback === "error" ? "" : undefined}
		>
			{t(shareFeedbackLabelKey(feedback, labelKey))}
		</Button>
	);
}
