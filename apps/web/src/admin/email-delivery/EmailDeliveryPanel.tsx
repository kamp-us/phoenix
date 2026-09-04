/**
 * The `FlagGate` is load-bearing, not cosmetic: with the default-off flag off, nothing renders
 * and no roll-up request fires, so this surface ships dark until a human flips it (ADR 0083).
 * It is the client half of a two-gate contract — the worker half fails the invisible `Denied`.
 */
import {Suspense, useState} from "react";
import {useFateClient, useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {EmailDeliveryState, FailingAddress} from "../../../worker/features/fate/views";
import {Alert} from "../../components/ui/Alert";
import {Button} from "../../components/ui/Button";
import {Input, Textarea} from "../../components/ui/Form";
import {codeOf} from "../../fate/wire";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_EMAIL_DELIVERY_ADMIN} from "../../flags/keys";
import {type CatalogKey, useLocale, useT} from "../../i18n";
import type {FateWireCode} from "../../lib/fateWireCodes";
import "./EmailDeliveryPanel.css";
import {emailDeliveryOutcomeKey, sinceLabel} from "./email-delivery";

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
	const t = useT();
	// A refetch nonce: the mark/clear mutations return an `EmailDeliveryState` (keyed on the
	// address), which never removes/adds a row in the `FailingAddress` roll-up connection, so
	// after a successful write we remount the reader (`key={reloadKey}`) to re-read it fresh.
	const [reloadKey, setReloadKey] = useState(0);
	const [messageKey, setMessageKey] = useState<CatalogKey>();

	function report(action: "mark" | "clear", code: FateWireCode | null, ok: boolean) {
		setMessageKey(emailDeliveryOutcomeKey(action, code));
		if (ok) setReloadKey((k) => k + 1);
	}

	return (
		<section
			className="kp-email-delivery"
			aria-label={t("admin.emailDelivery.label")}
			data-testid="email-delivery-panel"
		>
			<MarkForm onResult={(code, ok) => report("mark", code, ok)} />
			{messageKey ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-email-delivery__message"
					aria-live="polite"
					data-testid="email-delivery-message"
				>
					{t(messageKey)}
				</Alert>
			) : null}
			<Suspense
				fallback={<p className="kp-email-delivery__loading">{t("admin.emailDelivery.loading")}</p>}
			>
				<FailingList key={reloadKey} onResult={(code, ok) => report("clear", code, ok)} />
			</Suspense>
		</section>
	);
}

function MarkForm({
	onResult,
}: {
	readonly onResult: (code: FateWireCode | null, ok: boolean) => void;
}) {
	const t = useT();
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
		<form
			className="kp-email-delivery__form"
			onSubmit={onSubmit}
			aria-label={t("admin.emailDelivery.form.label")}
		>
			<Input
				className="kp-email-delivery__field kp-email-delivery__user-input"
				label={t("admin.emailDelivery.form.userId")}
				value={userId}
				onChange={(e) => setUserId(e.target.value)}
				required
				fullWidth
				data-testid="email-delivery-mark-user"
			/>
			<Textarea
				className="kp-email-delivery__field kp-email-delivery__reason"
				label={t("admin.emailDelivery.form.reason")}
				value={reason}
				onChange={(e) => setReason(e.target.value)}
				required
				resize="vertical"
				data-testid="email-delivery-mark-reason"
			/>
			<Button
				variant="danger"
				size="sm"
				type="submit"
				disabled={busy}
				data-testid="email-delivery-mark-button"
			>
				{busy ? t("admin.emailDelivery.marking") : t("admin.emailDelivery.mark")}
			</Button>
		</form>
	);
}

function FailingList({
	onResult,
}: {
	readonly onResult: (code: FateWireCode | null, ok: boolean) => void;
}) {
	const t = useT();
	const result = useRequest(
		{"emailDelivery.failing": {list: FailingConnectionView}},
		{mode: "network-only"},
	);
	const [items] = useListView(FailingConnectionView, result["emailDelivery.failing"]);

	if (items.length === 0) {
		return (
			<p className="kp-email-delivery__empty" data-testid="email-delivery-empty">
				{t("admin.emailDelivery.empty")}
			</p>
		);
	}

	return (
		<table className="kp-email-delivery__table" data-testid="email-delivery-table">
			<caption className="kp-email-delivery__caption">{t("admin.emailDelivery.caption")}</caption>
			<thead>
				<tr>
					<th scope="col">{t("admin.emailDelivery.column.address")}</th>
					<th scope="col">{t("admin.emailDelivery.column.account")}</th>
					<th scope="col">{t("admin.emailDelivery.column.reason")}</th>
					<th scope="col">{t("admin.emailDelivery.column.since")}</th>
					<th scope="col">{t("admin.emailDelivery.column.action")}</th>
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
	const t = useT();
	const {locale} = useLocale();
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
			<td>{data.userId ?? t("admin.emailDelivery.account.none")}</td>
			<td>{data.reason ?? t("admin.emailDelivery.reason.none")}</td>
			<td>{sinceLabel(data.since, locale)}</td>
			<td>
				{data.userId !== null ? (
					<Button
						variant="secondary"
						size="sm"
						onClick={onClear}
						disabled={busy}
						data-testid={`email-delivery-clear-${data.id}`}
					>
						{busy ? t("admin.emailDelivery.clearing") : t("admin.emailDelivery.clear")}
					</Button>
				) : null}
			</td>
		</tr>
	);
}
