/**
 * `EmailDeliveryPanel` — the email-delivery admin console module (#2732, email-bounce epic
 * #2687), the React consumer of the worker admin surface #2731 landed. It lists the
 * currently-failing addresses off the `emailDelivery.failing` roll-up and drives the
 * `emailDelivery.mark` / `emailDelivery.clear` admin mutations.
 *
 * Gated behind the default-off `phoenix-email-delivery-admin` flag via `FlagGate` (the
 * ban-controls stance): with it off nothing renders and no roll-up request fires, so the
 * surface ships dark until a human flips the flag (ADR 0083) — the client half of the
 * two-gate contract whose worker half fails the invisible `Denied`. The mutations are
 * account-keyed (`userId`), so a failing address with no resolved account (`userId: null`)
 * shows in the roll-up but carries no clear affordance — there is no account to target.
 *
 * Render decisions live DOM-free in `email-delivery.ts` (unit-tested); this is the thin
 * shell. a11y: a labelled region + table; the mark form is a real `<form>` with a required
 * `gerekçe`; outcomes are text in a `role="status"` live region, never color; lowercase
 * Turkish copy per the design law.
 */
import {Suspense, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {EmailDeliveryState, FailingAddress} from "../../../worker/features/fate/views";
import {Button} from "../../components/ui/Button";
import {codeOf} from "../../fate/wire";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_EMAIL_DELIVERY_ADMIN} from "../../flags/keys";
import type {FateWireCode} from "../../lib/fateWireCodes";
import "./EmailDeliveryPanel.css";
import {
	emailDeliveryOutcomeMessage,
	reasonLabel,
	resolvedUserLabel,
	sinceLabel,
} from "./email-delivery";

const FailingRowView = view<FailingAddress>()({
	id: true,
	address: true,
	userId: true,
	reason: true,
	since: true,
});

const FailingConnectionView = {items: {node: FailingRowView}} as const;

const EmailDeliveryStateSelect = view<EmailDeliveryState>()({
	id: true,
	failing: true,
	reason: true,
});

export default function EmailDeliveryPanel() {
	return (
		<FlagGate flag={PHOENIX_EMAIL_DELIVERY_ADMIN}>
			<EmailDeliveryAdmin />
		</FlagGate>
	);
}

function EmailDeliveryAdmin() {
	// A refetch nonce: the mark/clear mutations return an `EmailDeliveryState` (keyed on the
	// address), which never removes/adds a row in the `FailingAddress` roll-up connection, so
	// after a successful write we remount the reader (`key={reloadKey}`) to re-read it fresh.
	const [reloadKey, setReloadKey] = useState(0);
	const [message, setMessage] = useState("");

	function report(action: "mark" | "clear", code: FateWireCode | null, ok: boolean) {
		setMessage(emailDeliveryOutcomeMessage(action, code));
		if (ok) setReloadKey((k) => k + 1);
	}

	return (
		<section
			className="kp-email-delivery"
			aria-label="e-posta teslimatı"
			data-testid="email-delivery-panel"
		>
			<MarkForm onResult={(code, ok) => report("mark", code, ok)} />
			{message ? (
				<p
					className="kp-email-delivery__message"
					role="status"
					aria-live="polite"
					data-testid="email-delivery-message"
				>
					{message}
				</p>
			) : null}
			<Suspense fallback={<p className="kp-email-delivery__loading">yükleniyor…</p>}>
				<FailingList key={reloadKey} onResult={(code, ok) => report("clear", code, ok)} />
			</Suspense>
		</section>
	);
}

/** The manual mark form — target a user by id + a required reason (mirrors the ban form). */
function MarkForm({
	onResult,
}: {
	readonly onResult: (code: FateWireCode | null, ok: boolean) => void;
}) {
	const fate = useFateClient();
	const [userId, setUserId] = useState("");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);

	async function onSubmit(event: React.FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		try {
			const {error} = await fate.mutations.emailDelivery.mark({
				input: {userId, reason},
				view: EmailDeliveryStateSelect,
			});
			onResult(error ? codeOf(error) : null, !error);
			if (!error) {
				setUserId("");
				setReason("");
			}
		} catch (caught) {
			onResult(codeOf(caught), false);
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="kp-email-delivery__form" onSubmit={onSubmit} aria-label="adres işaretle">
			<label className="kp-email-delivery__field">
				kullanıcı kimliği
				<input
					className="kp-email-delivery__user-input"
					value={userId}
					onChange={(e) => setUserId(e.target.value)}
					required
					data-testid="email-delivery-mark-user"
				/>
			</label>
			<label className="kp-email-delivery__field">
				gerekçe
				<textarea
					className="kp-email-delivery__reason"
					value={reason}
					onChange={(e) => setReason(e.target.value)}
					required
					data-testid="email-delivery-mark-reason"
				/>
			</label>
			<Button
				variant="danger"
				size="sm"
				type="submit"
				disabled={busy}
				data-testid="email-delivery-mark-button"
			>
				{busy ? "işaretleniyor…" : "işaretle"}
			</Button>
		</form>
	);
}

function FailingList({
	onResult,
}: {
	readonly onResult: (code: FateWireCode | null, ok: boolean) => void;
}) {
	const result = useRequest(
		{"emailDelivery.failing": {list: FailingConnectionView}},
		{mode: "network-only"},
	);
	const [items] = useListView(FailingConnectionView, result["emailDelivery.failing"]);

	if (items.length === 0) {
		return (
			<p className="kp-email-delivery__empty" data-testid="email-delivery-empty">
				şu an başarısız olan adres yok — kuyruk temiz.
			</p>
		);
	}

	return (
		<table className="kp-email-delivery__table" data-testid="email-delivery-table">
			<caption className="kp-email-delivery__caption">başarısız e-posta adresleri</caption>
			<thead>
				<tr>
					<th scope="col">adres</th>
					<th scope="col">hesap</th>
					<th scope="col">gerekçe</th>
					<th scope="col">başlangıç</th>
					<th scope="col">işlem</th>
				</tr>
			</thead>
			<tbody>
				{items.map(({node}) => (
					<FailingRow key={node.id} node={node} onResult={onResult} />
				))}
			</tbody>
		</table>
	);
}

function FailingRow({
	node,
	onResult,
}: {
	readonly node: ViewRef<"FailingAddress">;
	readonly onResult: (code: FateWireCode | null, ok: boolean) => void;
}) {
	const data = useView(FailingRowView, node);
	const fate = useFateClient();
	const [busy, setBusy] = useState(false);

	async function onClear() {
		if (busy || data.userId === null) return;
		setBusy(true);
		try {
			const {error} = await fate.mutations.emailDelivery.clear({
				input: {userId: data.userId},
				view: EmailDeliveryStateSelect,
			});
			onResult(error ? codeOf(error) : null, !error);
		} catch (caught) {
			onResult(codeOf(caught), false);
		} finally {
			setBusy(false);
		}
	}

	return (
		<tr data-testid={`email-delivery-row-${data.id}`}>
			<td className="kp-email-delivery__address">{data.address}</td>
			<td>{resolvedUserLabel(data.userId)}</td>
			<td>{reasonLabel(data.reason)}</td>
			<td>{sinceLabel(data.since)}</td>
			<td>
				{data.userId !== null ? (
					<Button
						variant="secondary"
						size="sm"
						onClick={onClear}
						disabled={busy}
						data-testid={`email-delivery-clear-${data.id}`}
					>
						{busy ? "temizleniyor…" : "temizle"}
					</Button>
				) : null}
			</td>
		</tr>
	);
}
