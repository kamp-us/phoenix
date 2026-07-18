import {Button} from "./Button";
import "./DraftRestoreBanner.css";

/**
 * The "you have a saved draft — restore it?" affordance, shown when a draft survived
 * the auth round-trip. The draft is OFFERED, never silently re-injected (issue #1214):
 * the user explicitly restores or discards it. Real semantics — a labelled `<section>`
 * landmark with two native buttons (full keyboard path + visible focus from `kp-btn`);
 * state is conveyed by text, not color alone. Copy is lowercase Turkish.
 *
 * @component DraftRestoreBanner
 * @whenToUse The saved-draft restore prompt. Reach for it after a flow that may have
 *   stashed a draft across the auth round-trip — it OFFERS restore/discard rather
 *   than silently re-injecting (#1214). Wire `onRestore`/`onDismiss` to the caller's
 *   draft store.
 * @slot none Fixed copy + two actions; no children slot.
 */
export function DraftRestoreBanner({
	onRestore,
	onDismiss,
}: {
	/** Called when the user accepts — restore the stashed draft. */
	onRestore: () => void;
	/** Called when the user declines — discard/ignore the stashed draft. */
	onDismiss: () => void;
}) {
	return (
		<section
			className="kp-draft-restore"
			aria-label="kaydedilmiş taslak"
			data-testid="draft-restore"
		>
			<p className="kp-draft-restore__text">
				kaydedilmiş bir taslağın var. geri yüklemek ister misin?
			</p>
			<div className="kp-draft-restore__actions">
				<Button
					type="button"
					variant="primary"
					size="sm"
					onClick={onRestore}
					data-testid="draft-restore-accept"
				>
					taslağı geri yükle
				</Button>
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					onClick={onDismiss}
					data-testid="draft-restore-dismiss"
				>
					yoksay
				</Button>
			</div>
		</section>
	);
}
