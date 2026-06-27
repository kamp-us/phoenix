/**
 * `PromotionActions` — the thin moderator-facing surface for the çaylak→yazar
 * promotion (#1206). One affordance on a profile: a moderator "yazarlığa yükselt"
 * (direct promote). The server is the sole authority (`user.promote` is
 * `Moderate`-gated) — this surface just calls the mutation and reports the outcome;
 * an unauthorized click comes back denied and shows "yetkin yok", never a
 * client-side authority guess.
 *
 * Deliberately MOD-DIRECT ONLY: the author-vouch path's UI (a vouch / vouch-discovery
 * surface) is deferred to a separate product slice while its UX — and the open
 * sandbox-visibility-for-yazars question (#1205) — is designed. The vouch *mechanism*
 * ships server-side (`user.vouch`); only its surface is held back here.
 *
 * Mounted behind the #1204 authorship-loop flag (default-off) by the page's
 * `FlagGate`, so the whole surface stays dark until a human flips the flag.
 *
 * a11y: a native `<button>` (focusable, keyboard-activatable, visible focus from the
 * app's button styles); the section is a labelled landmark; the outcome is a
 * `role="status" aria-live="polite"` text region (state conveyed as words, never
 * color); copy is lowercase Turkish; no animation (reduced-motion-safe by default).
 */
import {useState} from "react";
import {useFateClient, view} from "react-fate";
import type {PromotionReceipt} from "../../../worker/features/fate/views";
import {codeOf} from "../../fate/wire";

const PromotionReceiptView = view<PromotionReceipt>()({
	userId: true,
	promoted: true,
	vouchRecorded: true,
});

/** The promotion-surface outcome the status line renders. */
export type PromotionOutcome = "promoted" | "alreadyYazar" | "denied" | "error";

interface PromotionResult {
	promoted?: boolean;
	vouchRecorded?: boolean;
}

/** A denial (authority) error vs any other failure — the two error outcomes. */
const errorOutcome = (error: unknown): PromotionOutcome => {
	const code = codeOf(error);
	return code === "UNAUTHORIZED" || code === "FORBIDDEN" ? "denied" : "error";
};

/** Map a `user.promote` call's `{result, error}` onto its outcome. */
export function promoteOutcome(
	result: PromotionResult | null | undefined,
	error: unknown,
): PromotionOutcome {
	if (error) return errorOutcome(error);
	return result?.promoted ? "promoted" : "alreadyYazar";
}

/** The lowercase-Turkish status line for an outcome — words, never color. */
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

export function PromotionActions({userId}: {userId: string}) {
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
			setMessage(promotionOutcomeMessage(promoteOutcome(result, error)));
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
				<button
					type="button"
					className="kp-promotion__action"
					onClick={onPromote}
					disabled={busy}
					data-testid="promote-button"
				>
					yazarlığa yükselt
				</button>
			</div>
			<p
				className="kp-promotion__status"
				role="status"
				aria-live="polite"
				data-testid="promotion-status"
			>
				{message}
			</p>
		</section>
	);
}
