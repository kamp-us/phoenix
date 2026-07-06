// The "incelemede" in-review badge a çaylak sees on their OWN sandboxed content
// (#2200). The `sandboxed` wire flag is owner-scoped server-side, so a caller only
// ever has it `true` for the author themselves — this is the shared render for the
// post-detail + definition surfaces (the profile katkıların list has its own #1291
// badge). State is carried by the word, not color alone (the AA-contrast tokens).
import "./ReviewBadge.css";

export function ReviewBadge() {
	return (
		<span className="kp-review-badge" data-testid="incelemede-badge">
			incelemede
		</span>
	);
}
