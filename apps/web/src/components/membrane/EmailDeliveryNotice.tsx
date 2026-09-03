import {Button} from "@kampus/design";
import {Link} from "react-router";
import "./EmailDeliveryNotice.css";

// The failing state is carried by text, never color alone — four-pillars a11y (ADR 0162).
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
