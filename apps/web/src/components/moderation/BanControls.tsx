/**
 * `BanControls` — the moderator-UI ban/unban affordance for one actor (#970, epic
 * #1665). Shows the actor's current banned-state + reason and lets an admin ban
 * (reason + optional expiry) or unban. Reads/writes the `requireAdmin`-gated,
 * `phoenix-user-ban`-flagged fate surface, so a non-admin's read/write fails closed
 * server-side (the read degrades to hidden, the write to the "no authority" message).
 *
 * The caller renders this INSIDE a `<FlagGate flag={PHOENIX_USER_BAN}>`, so with the
 * flag off (default / Flagship outage) the whole control is dark — the client half of
 * the ship-dark contract (ADR 0083). Render decisions are DOM-free in
 * `ban-controls.ts` (unit-tested); this is the thin shell.
 *
 * a11y: a labelled region; a real `<form>` with a required `gerekçe` field + an
 * optional `datetime-local` expiry; real `<button>`s; the banned-state + outcome are
 * text in `role="status"` live regions, never color; copy is lowercase Turkish.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {BanState} from "../../../worker/features/fate/views";
import {useImperativeView} from "../../fate/useImperativeView";
import {codeOf} from "../../fate/wire";
import {Button} from "../ui/Button";
import {
	type BanView,
	banExpiryLabel,
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
	const fate = useFateClient();
	const {state, refetch} = useImperativeView("user.banState", BanStateSelect, {
		args: {userId},
		enabled: true,
		deps: [userId],
	});
	const [reason, setReason] = useState("");
	const [expiry, setExpiry] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	const current: BanView | null = state.status === "ok" && state.data ? state.data : null;

	async function onBan(event: React.FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setMessage("");
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
		setMessage("");
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

	const expiryLabel = current ? banExpiryLabel(current) : null;

	return (
		<section className="kp-ban" aria-label="yasaklama" data-testid="ban-controls">
			<p className="kp-ban__status" role="status" aria-live="polite" data-testid="ban-status">
				{current ? banStatusLabel(current) : "durum yükleniyor…"}
			</p>
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
					{busy ? "kaldırılıyor…" : "yasağı kaldır"}
				</Button>
			) : (
				<form className="kp-ban__form" onSubmit={onBan}>
					<label className="kp-ban__field">
						gerekçe
						<textarea
							className="kp-ban__reason"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							required
							data-testid="ban-reason"
						/>
					</label>
					<label className="kp-ban__field">
						süre bitişi (isteğe bağlı)
						<input
							type="datetime-local"
							className="kp-ban__expiry-input"
							value={expiry}
							onChange={(e) => setExpiry(e.target.value)}
							data-testid="ban-expiry-input"
						/>
					</label>
					<Button variant="danger" size="sm" type="submit" disabled={busy} data-testid="ban-button">
						{busy ? "yasaklanıyor…" : "yasakla"}
					</Button>
				</form>
			)}

			{message ? (
				<p className="kp-ban__message" role="status" aria-live="polite" data-testid="ban-message">
					{message}
				</p>
			) : null}
		</section>
	);
}
