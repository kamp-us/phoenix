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
import {type CatalogKey, useT} from "../../i18n";
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

export function promotionOutcomeMessageKey(outcome: PromotionOutcome): CatalogKey {
	switch (outcome) {
		case "promoted":
			return "profile.promotion.outcome.promoted";
		case "alreadyYazar":
			return "profile.promotion.outcome.alreadyYazar";
		case "denied":
			return "profile.promotion.outcome.denied";
		case "error":
			return "profile.promotion.outcome.error";
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
	const t = useT();
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
			setMessage(t(promotionOutcomeMessageKey(outcome)));
			if (promoteRefreshWarranted(outcome)) onSuccessRefresh?.();
		} catch (caught) {
			setMessage(t(promotionOutcomeMessageKey(errorOutcome(caught))));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			className="kp-promotion"
			aria-label={t("profile.promotion.sectionLabel")}
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
					{t("profile.promotion.action")}
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
