// The "incelemede" in-review badge a çaylak sees on their OWN sandboxed content
// (#2200). The `sandboxed` wire flag is owner-scoped server-side, so a caller only
// ever has it `true` for the author themselves — this is the shared render for the
// post-detail + definition surfaces (the profile katkıların list has its own #1291
// badge). State is carried by the word, not color alone (the AA-contrast tokens).
import "./ReviewBadge.css";

/**
 * @component ReviewBadge
 * @whenToUse The incelemede in-review badge. Reach for it on a çaylak's OWN
 *   sandboxed content (post-detail, definition) to signal it is pending review —
 *   the `sandboxed` wire flag is owner-scoped, so only the author sees it. The
 *   profile katkıların list has its own #1291 badge; don't reuse this there.
 * @slot none Fixed copy; no children slot.
 */
export function ReviewBadge() {
	return (
		<span className="kp-review-badge" data-testid="incelemede-badge">
			incelemede
		</span>
	);
}
