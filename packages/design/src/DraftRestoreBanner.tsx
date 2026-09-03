import {Button} from "./Button";
import "./DraftRestoreBanner.css";

/**
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
	onRestore: () => void;
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
