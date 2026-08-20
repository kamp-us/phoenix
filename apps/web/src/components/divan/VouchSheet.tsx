/**
 * `VouchSheet` — the stake-confirm sheet for the yazar "kefil ol" (#1290, consumes #1289).
 * Vouching holds one of the yazar's three concurrent slots until the çaylak is promoted or
 * the vouch is withdrawn, so the action is never one-click. The server is the sole
 * authority: a non-yazar call comes back `FORBIDDEN`, a 4th concurrent vouch
 * `VOUCH_LIMIT_REACHED`.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {PromotionReceipt} from "../../../worker/features/fate/views";
import {codeOf} from "../../fate/wire";
import {Alert} from "../ui/Alert";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {type VouchOutcome, vouchOutcome, vouchOutcomeMessage} from "./divanGating";

const VouchReceiptView = view<PromotionReceipt>()({
	userId: true,
	promoted: true,
	vouchRecorded: true,
});

export function VouchSheet({
	open,
	onOpenChange,
	candidateId,
	onResolved,
}: {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly candidateId: string;
	readonly onResolved?: (outcome: VouchOutcome) => void;
}) {
	const fate = useFateClient();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	function reset() {
		setBusy(false);
		setMessage("");
	}

	async function onConfirm() {
		if (busy) return;
		setBusy(true);
		setMessage("");
		try {
			const {result, error} = await fate.mutations.user.vouch({
				input: {candidateId},
				view: VouchReceiptView,
			});
			const outcome = vouchOutcome(
				(result as {promoted?: boolean} | null)?.promoted,
				error ? codeOf(error) : null,
				!!error,
			);
			setMessage(vouchOutcomeMessage(outcome));
			onResolved?.(outcome);
		} catch (caught) {
			const outcome = vouchOutcome(undefined, codeOf(caught), true);
			setMessage(vouchOutcomeMessage(outcome));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open={open}
			title="kefil ol"
			description="incelediğin çaylağa kefil oluyorsun."
			onOpenChange={(next) => {
				if (!next) reset();
				onOpenChange(next);
			}}
			footer={({close}) => (
				<>
					<Button variant="tertiary" onClick={close}>
						vazgeç
					</Button>
					<Button
						variant="primary"
						onClick={onConfirm}
						disabled={busy}
						loading={busy}
						data-testid="vouch-confirm-button"
					>
						{busy ? "kefil olunuyor…" : "kefil ol"}
					</Button>
				</>
			)}
		>
			<p className="kp-divan__stake">
				kefil olmak bir taahhüttür: kendi itibarını ortaya koyarsın ve aynı anda en fazla üç kişiye
				kefil olabilirsin. çaylak yeterli karmaya ulaştığında, kefilinle birlikte yazar olur.
				dilediğinde kefilliğini geri çekebilirsin.
			</p>
			{message ? (
				<Alert
					variant="secondary"
					className="kp-alert--inline kp-divan__status"
					aria-live="polite"
					data-testid="vouch-status"
				>
					{message}
				</Alert>
			) : null}
		</Dialog>
	);
}
