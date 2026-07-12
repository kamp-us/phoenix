import {Link} from "react-router";
import {Button} from "../ui/Button";
import "./EmailDeliveryNotice.css";

/**
 * The membrane notice a signed-in user with a failing email address sees (epic #2687, Child
 * #2693): a plain-language Turkish signal that our mail is bouncing, plus a recovery CTA into
 * the existing change-email flow. Presentational + prop-driven — the flag/failing/dismiss gate
 * lives in {@link EmailDeliveryNoticeMount}, so the render contract is testable in isolation.
 *
 * The state is carried by TEXT, never color alone (four-pillars a11y): a labelled `<section>`
 * landmark with a `role="status"` live region so it is announced when it appears, the CTA is a
 * real navigating anchor, and dismissal is a native button.
 */
export function EmailDeliveryNotice({
	recoveryHref,
	onDismiss,
}: {
	recoveryHref: string;
	onDismiss?: () => void;
}) {
	return (
		<section
			className="kp-email-notice"
			role="status"
			aria-label="e-posta teslimat uyarısı"
			data-testid="email-delivery-notice"
		>
			<div className="kp-email-notice__body">
				<p className="kp-email-notice__title">e-postana ulaşamıyoruz</p>
				<p className="kp-email-notice__text">
					adresine gönderdiğimiz e-postalar geri dönüyor — giriş bağlantıların ve doğrulama
					e-postaların sana ulaşmıyor olabilir. adresini güncelle ya da yeniden doğrula.
				</p>
			</div>
			<div className="kp-email-notice__actions">
				<Link
					to={recoveryHref}
					className="kp-btn kp-btn--primary kp-email-notice__cta"
					data-testid="email-delivery-notice-cta"
				>
					e-postanı güncelle
				</Link>
				{onDismiss ? (
					<Button
						type="button"
						variant="tertiary"
						size="sm"
						onClick={onDismiss}
						data-testid="email-delivery-notice-dismiss"
					>
						kapat
					</Button>
				) : null}
			</div>
		</section>
	);
}
