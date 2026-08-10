// The "incelemede" in-review badge (#2200) — the ONE renderer of that state, on every
// surface that shows it: the author's own sandboxed content (post-detail, definition,
// the profile katkıların list) and the divan's review queue. The profile list and divan
// each carried their own copy until #5228 folded them in. State is carried by the word,
// not color alone (the AA-contrast tokens).
import {Badge} from "./Badge";
import "./ReviewBadge.css";

/**
 * @component ReviewBadge
 * @whenToUse Every "incelemede" (pending review) badge, wherever it renders — the
 *   author's own sandboxed content (post-detail, definition, profile katkıların) and
 *   the divan review queue. Never hand-roll a second one; a feature class over a raw
 *   `Badge` variant is how the divan chip ended up grey-on-blue (#5228).
 * @slot none Fixed copy; no children slot.
 */
export function ReviewBadge() {
	return (
		<Badge variant="info" className="kp-review-badge" data-testid="incelemede-badge">
			incelemede
		</Badge>
	);
}
