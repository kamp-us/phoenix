// This control does no flag check of its own: the caller must render it inside a
// `<FlagGate flag={PHOENIX_USER_BAN}>` so it goes dark by default (ADR 0083).
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {BanState} from "../../../worker/features/fate/views";
import {useImperativeView} from "../../fate/useImperativeView";
import {codeOf} from "../../fate/wire";
import {type CatalogKey, useLocale, useT} from "../../i18n";
import {Alert} from "../ui/Alert";
import {Button} from "../ui/Button";
import {Input, Textarea} from "../ui/Form";
import {
	type BanView,
	banExpiry,
	banOutcomeMessage,
	banStatusLabel,
	parseExpiry,
} from "./ban-controls";

const BanStateSelect = view<BanState>()({
	id: true,
	banned: true,
	reason: true,
	expiresAt: true,
});

export function BanControls({userId}: {readonly userId: string}) {
	const t = useT();
	const {locale} = useLocale();
	const fate = useFateClient();
	const {state, refetch} = useImperativeView("user.banState", BanStateSelect, {
		args: {userId},
		enabled: true,
		deps: [userId],
	});
	const [reason, setReason] = useState("");
	const [expiry, setExpiry] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<CatalogKey | null>(null);

	const current: BanView | null = state.status === "ok" && state.data ? state.data : null;

	async function onBan(event: React.FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setMessage(null);
		try {
			const {error} = await fate.mutations.user.banUser({
				input: {userId, reason, expiresAt: parseExpiry(expiry)},
				view: BanStateSelect,
			});
			setMessage(banOutcomeMessage("ban", error ? codeOf(error) : null));
			if (!error) {
				setReason("");
				setExpiry("");
				await refetch();
			}
		} catch (caught) {
			setMessage(banOutcomeMessage("ban", codeOf(caught)));
		} finally {
			setBusy(false);
		}
	}

	async function onUnban() {
		if (busy) return;
		setBusy(true);
		setMessage(null);
		try {
			const {error} = await fate.mutations.user.unbanUser({
				input: {userId},
				view: BanStateSelect,
			});
			setMessage(banOutcomeMessage("unban", error ? codeOf(error) : null));
			if (!error) await refetch();
		} catch (caught) {
			setMessage(banOutcomeMessage("unban", codeOf(caught)));
		} finally {
			setBusy(false);
		}
	}

	const status = current ? banStatusLabel(current) : null;
	const expiryState = current ? banExpiry(current) : null;
	const expiryLabel =
		expiryState === null
			? null
			: expiryState.kind === "permanent"
				? t("divan.ban.expiry.permanent")
				: t("divan.ban.expiry.until", {
						date: new Date(expiryState.at).toLocaleString(locale === "tr" ? "tr-TR" : "en-US"),
					});

	return (
		<section className="kp-ban" aria-label={t("divan.ban.label")} data-testid="ban-controls">
			<Alert
				variant="secondary"
				className="kp-alert--inline kp-ban__status"
				aria-live="polite"
				data-testid="ban-status"
			>
				{status === null ? t("divan.ban.loading") : t(status.key, status.params)}
			</Alert>
			{expiryLabel !== null && (
				<p className="kp-ban__expiry" data-testid="ban-expiry">
					{expiryLabel}
				</p>
			)}

			{current?.banned ? (
				<Button
					variant="secondary"
					size="sm"
					onClick={onUnban}
					disabled={busy}
					data-testid="unban-button"
				>
					{busy ? t("divan.ban.unbanBusy") : t("divan.ban.unban")}
				</Button>
			) : (
				<form className="kp-ban__form" onSubmit={onBan}>
					<Textarea
						className="kp-ban__field kp-ban__reason"
						label={t("divan.ban.reason")}
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						required
						data-testid="ban-reason"
						resize="vertical"
					/>
					<Input
						type="datetime-local"
						className="kp-ban__field kp-ban__expiry-input"
						label={t("divan.ban.expiryField")}
						value={expiry}
						onChange={(e) => setExpiry(e.target.value)}
						data-testid="ban-expiry-input"
					/>
					<Button variant="danger" size="sm" type="submit" disabled={busy} data-testid="ban-button">
						{busy ? t("divan.ban.busy") : t("divan.ban.action")}
					</Button>
				</form>
			)}

			{message !== null ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-ban__message"
					aria-live="polite"
					data-testid="ban-message"
				>
					{t(message)}
				</Alert>
			) : null}
		</section>
	);
}
