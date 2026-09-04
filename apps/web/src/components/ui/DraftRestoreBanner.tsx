import {useT} from "../../i18n";
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
	const t = useT();
	return (
		<section
			className="kp-draft-restore"
			aria-label={t("ui.draftRestore.label")}
			data-testid="draft-restore"
		>
			<p className="kp-draft-restore__text">{t("ui.draftRestore.text")}</p>
			<div className="kp-draft-restore__actions">
				<Button
					type="button"
					variant="primary"
					size="sm"
					onClick={onRestore}
					data-testid="draft-restore-accept"
				>
					{t("ui.draftRestore.restore")}
				</Button>
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					onClick={onDismiss}
					data-testid="draft-restore-dismiss"
				>
					{t("ui.draftRestore.dismiss")}
				</Button>
			</div>
		</section>
	);
}
