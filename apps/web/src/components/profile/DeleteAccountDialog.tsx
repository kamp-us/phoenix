/**
 * The "tehlikeli alan" account-deletion confirmation dialog. The confirm action
 * is gated behind typing the exact phrase `account.delete` requires
 * (`hesabımı kalıcı olarak sil`, mirrored from the worker's `Schema.Literal`):
 * the confirm button is disabled until the typed text matches, so a destructive
 * call on an unconfirmed dialog is unrepresentable. On success the caller clears
 * the session and the page redirects — see `onConfirmed`.
 *
 * The mutation classifies as boundary, so it may throw OR return `{error}`; we
 * handle both and surface the failure inline (see `.patterns/fate-mutations-client.md`).
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {AccountDeletionReceipt} from "../../../worker/features/fate/views";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";

// Mirrors the worker's `ACCOUNT_DELETE_CONFIRMATION` (`Schema.Literal`); the user
// types it verbatim and the mutation input re-validates it server-side.
export const CONFIRMATION_PHRASE = "hesabımı kalıcı olarak sil";

/** The gate: the confirm action is reachable only when the typed text is exact. */
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
	/** Run after the account is anonymized — clears the session and redirects. */
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
		<Dialog.Root
			open={open}
			onOpenChange={(v) => {
				if (!v) reset();
				onOpenChange(v);
			}}
		>
			<Dialog.Popup>
				<Dialog.Head
					title="hesabı kaldır"
					description="bu işlem geri alınamaz. devam etmek için aşağıdaki ifadeyi yaz."
				/>
				<Dialog.Body>
					<p className="kp-profile__confirm-phrase">
						<code>{CONFIRMATION_PHRASE}</code>
					</p>
					<input
						data-testid="delete-account-confirm-input"
						className="kp-profile__confirm-input"
						value={typed}
						autoComplete="off"
						aria-label="onay ifadesi"
						placeholder={CONFIRMATION_PHRASE}
						onChange={(e) => {
							setTyped(e.currentTarget.value);
							setError(null);
						}}
						disabled={pending}
					/>
					{error ? (
						<p className="kp-profile__error" role="alert">
							{error}
						</p>
					) : null}
				</Dialog.Body>
				<Dialog.Foot>
					<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
					<Button
						variant="danger"
						data-testid="delete-account-confirm-btn"
						disabled={!matches || pending}
						onClick={onConfirm}
					>
						{pending ? "kaldırılıyor…" : "hesabı kalıcı olarak kaldır"}
					</Button>
				</Dialog.Foot>
			</Dialog.Popup>
		</Dialog.Root>
	);
}
