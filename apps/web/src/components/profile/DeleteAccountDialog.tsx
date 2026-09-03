// The account-deletion confirmation dialog. `account.delete` is a boundary mutation,
// so it may throw OR return `{error}` and both paths are handled below — see
// `.patterns/fate-mutations-client.md`.

import {Button, Dialog, Input} from "@kampus/design";
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {AccountDeletionReceipt} from "../../../worker/features/fate/views";

// Mirrors the worker's `ACCOUNT_DELETE_CONFIRMATION` (`Schema.Literal`); the user
// types it verbatim and the mutation input re-validates it server-side.
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
				setError("hesap kaldırılamadı, tekrar dene.");
				return;
			}
			await onConfirmed();
		} catch {
			setError("hesap kaldırılamadı, tekrar dene.");
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog
			open={open}
			role="alertdialog"
			title="hesabı kaldır"
			description="bu işlem geri alınamaz. devam etmek için aşağıdaki ifadeyi yaz."
			onOpenChange={(v) => {
				if (!v) reset();
				onOpenChange(v);
			}}
			footer={({close}) => (
				<>
					<Button variant="tertiary" onClick={close}>
						vazgeç
					</Button>
					<Button
						variant="danger"
						data-testid="delete-account-confirm-btn"
						disabled={!matches || pending}
						loading={pending}
						onClick={onConfirm}
					>
						{pending ? "kaldırılıyor…" : "hesabı kalıcı olarak kaldır"}
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
				label={<span className="kp-visually-hidden">onay ifadesi</span>}
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
