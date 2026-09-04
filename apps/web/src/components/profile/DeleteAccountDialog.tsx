// The account-deletion confirmation dialog. `account.delete` is a boundary mutation,
// so it may throw OR return `{error}` and both paths are handled below — see
// `.patterns/fate-mutations-client.md`.

import {Button, Dialog, Input} from "@kampus/design";
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {AccountDeletionReceipt} from "../../../worker/features/fate/views";
import {useT} from "../../i18n";

// Mirrors the worker's `ACCOUNT_DELETE_CONFIRMATION` (`Schema.Literal`); the user types it
// verbatim and the mutation input re-validates it server-side. NOT catalog copy, and not
// translated: it is the wire literal the server accepts, so an English rendering of it would
// be a phrase the mutation rejects.
export const CONFIRMATION_PHRASE = "hesabımı kalıcı olarak sil";

export const matchesConfirmation = (typed: string): boolean => typed === CONFIRMATION_PHRASE;

const ReceiptView = view<AccountDeletionReceipt>()({
	id: true,
	deleted: true,
});

export function DeleteAccountDialog({
	open,
	onOpenChange,
	onConfirmed,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onConfirmed: () => Promise<void> | void;
}) {
	const fate = useFateClient();
	const t = useT();
	const [typed, setTyped] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const matches = matchesConfirmation(typed);

	function reset() {
		setTyped("");
		setError(null);
	}

	async function onConfirm() {
		if (!matches) return;
		setPending(true);
		setError(null);
		try {
			const {error: callError} = await fate.mutations.account.delete({
				input: {confirmation: CONFIRMATION_PHRASE},
				view: ReceiptView,
			});
			if (callError) {
				setError(t("profile.delete.error"));
				return;
			}
			await onConfirmed();
		} catch {
			setError(t("profile.delete.error"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog
			open={open}
			role="alertdialog"
			title={t("profile.delete.title")}
			description={t("profile.delete.description")}
			onOpenChange={(v) => {
				if (!v) reset();
				onOpenChange(v);
			}}
			footer={({close}) => (
				<>
					<Button variant="tertiary" onClick={close}>
						{t("profile.delete.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="delete-account-confirm-btn"
						disabled={!matches || pending}
						loading={pending}
						onClick={onConfirm}
					>
						{t(pending ? "profile.delete.pending" : "profile.delete.confirm")}
					</Button>
				</>
			)}
		>
			<p className="kp-profile__confirm-phrase">
				<code>{CONFIRMATION_PHRASE}</code>
			</p>
			<Input
				data-testid="delete-account-confirm-input"
				className="kp-profile__confirm-input"
				label={<span className="kp-visually-hidden">{t("profile.delete.inputLabel")}</span>}
				value={typed}
				autoComplete="off"
				placeholder={CONFIRMATION_PHRASE}
				onChange={(e) => {
					setTyped(e.currentTarget.value);
					setError(null);
				}}
				disabled={pending}
				fullWidth
				error={error}
			/>
		</Dialog>
	);
}
