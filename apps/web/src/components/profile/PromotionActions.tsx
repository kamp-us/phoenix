/**
 * The moderator-facing çaylak→yazar promote affordance. `user.promote` is
 * `Moderate`-gated server-side and stays the sole authority — the visibility gate
 * here is UX only, not a trust boundary.
 *
 * Deliberately MOD-DIRECT ONLY: the vouch mechanism ships server-side
 * (`user.vouch`), but its UI is held back pending the open
 * sandbox-visibility-for-yazars question (#1205).
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {PromotionReceipt} from "../../../worker/features/fate/views";
import {codeOf} from "../../fate/wire";
import {promoteRefreshWarranted, promoteVisible} from "../divan/divanGating";
import {Alert} from "../ui/Alert";
import {Button} from "../ui/Button";

export function shouldShowPromotionActions(isModerator: boolean, isOwnProfile: boolean): boolean {
	return promoteVisible(isModerator) && !isOwnProfile;
}

const PromotionReceiptView = view<PromotionReceipt>()({
	userId: true,
	promoted: true,
	vouchRecorded: true,
});

export type PromotionOutcome = "promoted" | "alreadyYazar" | "denied" | "error";

interface PromotionResult {
	promoted?: boolean;
	vouchRecorded?: boolean;
}

const errorOutcome = (error: unknown): PromotionOutcome => {
	const code = codeOf(error);
	return code === "UNAUTHORIZED" || code === "FORBIDDEN" ? "denied" : "error";
};

export function promoteOutcome(
	result: PromotionResult | null | undefined,
	error: unknown,
): PromotionOutcome {
	if (error) return errorOutcome(error);
	return result?.promoted ? "promoted" : "alreadyYazar";
}

export function promotionOutcomeMessage(outcome: PromotionOutcome): string {
	switch (outcome) {
		case "promoted":
			return "kullanıcı yazar oldu.";
		case "alreadyYazar":
			return "kullanıcı zaten yazar.";
		case "denied":
			return "bunu yapma yetkin yok.";
		case "error":
			return "işlem başarısız oldu.";
	}
}

export function PromotionActions({
	userId,
	onSuccessRefresh,
}: {
	userId: string;
	/** Invoked when the answer is evidence about the user's tier — the page re-pulls its own read. */
	onSuccessRefresh?: () => void;
}) {
	const fate = useFateClient();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");

	async function onPromote() {
		if (busy) return;
		setBusy(true);
		try {
			const {result, error} = await fate.mutations.user.promote({
				input: {userId},
				view: PromotionReceiptView,
			});
			const outcome = promoteOutcome(result, error);
			setMessage(promotionOutcomeMessage(outcome));
			if (promoteRefreshWarranted(outcome)) onSuccessRefresh?.();
		} catch (caught) {
			setMessage(promotionOutcomeMessage(errorOutcome(caught)));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			className="kp-promotion"
			aria-label="yazarlık işlemleri"
			data-testid="promotion-actions"
		>
			<div className="kp-promotion__buttons">
				<Button
					type="button"
					variant="primary"
					size="sm"
					className="kp-promotion__action"
					onClick={onPromote}
					disabled={busy}
					loading={busy}
					data-testid="promote-button"
				>
					yazarlığa yükselt
				</Button>
			</div>
			<Alert
				variant="secondary"
				className="kp-alert--inline kp-promotion__status"
				aria-live="polite"
				data-testid="promotion-status"
			>
				{message}
			</Alert>
		</section>
	);
}
