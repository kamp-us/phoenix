import {Button} from "@kampus/design";
import {Link} from "react-router";
import {useT} from "../../i18n";
import "./EmailDeliveryNotice.css";

// The failing state is carried by text, never color alone — four-pillars a11y (ADR 0162).
export function EmailDeliveryNotice({
	recoveryHref,
	onDismiss,
}: {
	recoveryHref: string;
	onDismiss?: () => void;
}) {
	const t = useT();
	return (
		<section
			className="kp-email-notice"
			role="status"
			aria-label={t("membrane.emailNotice.label")}
			data-testid="email-delivery-notice"
		>
			<div className="kp-email-notice__body">
				<p className="kp-email-notice__title">{t("membrane.emailNotice.title")}</p>
				<p className="kp-email-notice__text">{t("membrane.emailNotice.text")}</p>
			</div>
			<div className="kp-email-notice__actions">
				<Link
					to={recoveryHref}
					className="kp-btn kp-btn--primary kp-email-notice__cta"
					data-testid="email-delivery-notice-cta"
				>
					{t("membrane.emailNotice.cta")}
				</Link>
				{onDismiss ? (
					<Button
						type="button"
						variant="tertiary"
						size="sm"
						onClick={onDismiss}
						data-testid="email-delivery-notice-dismiss"
					>
						{t("membrane.emailNotice.dismiss")}
					</Button>
				) : null}
			</div>
		</section>
	);
}
