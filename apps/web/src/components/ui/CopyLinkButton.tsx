import * as React from "react";

/**
 * Shared `paylaş` (share/copy-link) button — presentation + inline confirmation only.
 * The page passes the item's canonical **path** (`/pano/:id`, `/sozluk/:slug`, or a
 * comment-anchor `/pano/:id#comment-<id>`); the button resolves it to an absolute URL
 * and copies it to the clipboard, locking into visible "kopyalandı" feedback. Where the
 * platform offers a native share sheet (`navigator.share`, mobile/PWA) it invokes that
 * instead. Reused by every share surface (pano post/comment, sözlük definition), so no
 * page-specific link logic lives in the shared content components.
 */

function absoluteUrl(path: string): string {
	return new URL(path, window.location.origin).toString();
}

async function shareOrCopy(url: string): Promise<"shared" | "copied" | "error"> {
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
	try {
		await navigator.clipboard.writeText(url);
		return "copied";
	} catch {
		return "error";
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
	const [copied, setCopied] = React.useState(false);
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
		// clipboard write flashes "kopyalandı" for two seconds, then resets.
		if (outcome !== "copied") return;
		setCopied(true);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 2000);
	}

	return (
		<button
			type="button"
			className={className}
			onClick={onClick}
			data-testid={testId}
			data-copied={copied ? "" : undefined}
		>
			{copied ? "kopyalandı" : label}
		</button>
	);
}
