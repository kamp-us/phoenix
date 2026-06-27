/**
 * `VouchSheet` — the stake-confirm sheet for the yazar **"kefil ol"** (vouch)
 * affordance (#1290, consumes #1289). Vouching is a stake: the yazar puts their
 * own standing behind the çaylak, and one of their three concurrent vouch slots
 * is held until the çaylak is promoted or the vouch is withdrawn. So the action
 * is never one-click — it opens this sheet, which states the stake plainly and
 * confirms before calling `user.vouch`.
 *
 * The server is the sole authority: `user.vouch` is the `requireVouch` (yazar
 * floor) gate plus the concurrent-vouch cap (#1289). A non-yazar call comes back
 * `FORBIDDEN`, a 4th concurrent vouch `VOUCH_LIMIT_REACHED` — both surfaced as
 * lowercase-Turkish words via {@link vouchOutcome}.
 *
 * a11y: a real modal dialog (`Dialog`, focus-trapped + Esc-closable + labelled
 * title/description from the shared primitive), native `<Button>`s (full keyboard
 * path + visible focus + AA contrast), the outcome a `role="status"
 * aria-live="polite"` text region (state as words, never color); copy is
 * lowercase Turkish; no animation beyond the dialog primitive's own, which the
 * global reduced-motion reset neutralizes.
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {PromotionReceipt} from "../../../worker/features/fate/views";
import {codeOf} from "../../fate/wire";
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
	/** Run after the vouch resolves, so the surface can react to the outcome. */
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
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) reset();
				onOpenChange(next);
			}}
		>
			<Dialog.Popup>
				<Dialog.Head title="kefil ol" description="incelediğin çaylağa kefil oluyorsun." />
				<Dialog.Body>
					<p className="kp-divan__stake">
						kefil olmak bir taahhüttür: kendi itibarını ortaya koyarsın ve aynı anda en fazla üç
						kişiye kefil olabilirsin. çaylak yeterli karmaya ulaştığında, kefilinle birlikte yazar
						olur. dilediğinde kefilliğini geri çekebilirsin.
					</p>
					{message ? (
						<p
							className="kp-divan__status"
							role="status"
							aria-live="polite"
							data-testid="vouch-status"
						>
							{message}
						</p>
					) : null}
				</Dialog.Body>
				<Dialog.Foot>
					<Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
					<Button
						variant="primary"
						onClick={onConfirm}
						disabled={busy}
						data-testid="vouch-confirm-button"
					>
						{busy ? "kefil olunuyor…" : "kefil ol"}
					</Button>
				</Dialog.Foot>
			</Dialog.Popup>
		</Dialog.Root>
	);
}
