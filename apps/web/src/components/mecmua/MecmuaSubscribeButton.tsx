/**
 * The mecmua "abone ol / takip ediliyor" subscribe toggle (#2527, epic #2467) — the
 * missing entry point that lets a reader follow a post's author so the subscribed-author
 * feed (#2500) can populate through the product. Rendered on the post reader
 * (`pages/MecmuaPostPage`); wired to the existing `mecmua.subscribe` / `mecmua.unsubscribe`
 * mutations, with the current edge state read off the `mecmuaSubscription` root.
 *
 * Gating mirrors the mutations exactly (`CurrentUser.required`, behind `MECMUA_FEED`):
 * signed-in only — subscribing is not tier-gated (a çaylak may follow), unlike publishing.
 * The toggle only renders when the feed flag is on AND the reader is signed in AND the
 * author isn't the reader themselves, so it appears exactly where it can act. The whole
 * surface stays dark until a human flips `MECMUA_FEED` at release (ADR 0083).
 */
import {useMemo, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {MecmuaSubscriptionReceipt} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {useImperativeView} from "../../fate/useImperativeView";
import {MECMUA_FEED} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {Button} from "../ui/Button";
import "./MecmuaSubscribeButton.css";

const SubscriptionView = view<MecmuaSubscriptionReceipt>()({
	id: true,
	subscribed: true,
});

/**
 * The toggle's label, factored DOM-free so the "takip ediliyor → bırak" hover swap is
 * unit-testable without a DOM (the `mecmuaPublishAffordance` pure-core idiom). Not yet
 * following ⇒ "abone ol"; following ⇒ "takip ediliyor", swapping to "bırak" on
 * hover/focus so the unsubscribe intent reads honestly.
 */
export function mecmuaSubscribeLabel(subscribed: boolean, hovering: boolean): string {
	if (!subscribed) return "abone ol";
	return hovering ? "bırak" : "takip ediliyor";
}

export function MecmuaSubscribeButton({authorId}: {authorId: string}) {
	const {value: feedOn, loading: flagLoading} = useFlag(MECMUA_FEED, false);
	const session = useSession();
	const {me} = useMe();

	// The toggle can only act when the feed is on and the reader is signed in; a reader
	// following themselves is meaningless, so hide it on your own post too.
	if (flagLoading || !feedOn || !session.data) return null;
	if (me?.id === authorId) return null;

	return <MecmuaSubscribeToggle authorId={authorId} />;
}

function MecmuaSubscribeToggle({authorId}: {authorId: string}) {
	const fate = useFateClient();
	const args = useMemo(() => ({authorId}), [authorId]);
	const {state, refetch} = useImperativeView("mecmuaSubscription", SubscriptionView, {
		args,
		enabled: true,
	});

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hovering, setHovering] = useState(false);

	// Don't render a guessy control until the initial edge state resolves, or the button
	// would flash "abone ol" for a reader who already follows this author.
	if (state.status === "idle" || state.status === "loading") return null;

	const subscribed = state.status === "ok" ? Boolean(state.data?.subscribed) : false;

	async function toggle() {
		setError(null);
		setPending(true);
		try {
			const op = subscribed ? fate.mutations.mecmua.unsubscribe : fate.mutations.mecmua.subscribe;
			const res = await op({input: {authorId}, view: SubscriptionView});
			if (res.error) {
				setError(
					subscribed ? "abonelikten çıkılamadı, tekrar dene." : "abone olunamadı, tekrar dene.",
				);
				return;
			}
			await refetch();
		} catch {
			setError("bir şeyler ters gitti, tekrar dene.");
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="kp-mecmua-subscribe">
			<Button
				type="button"
				variant={subscribed ? "secondary" : "primary"}
				size="sm"
				pressed={subscribed}
				loading={pending}
				data-testid="mecmua-subscribe-toggle"
				onClick={toggle}
				onMouseEnter={() => setHovering(true)}
				onMouseLeave={() => setHovering(false)}
				onFocus={() => setHovering(true)}
				onBlur={() => setHovering(false)}
			>
				{mecmuaSubscribeLabel(subscribed, hovering)}
			</Button>
			{error ? (
				<p className="kp-mecmua-subscribe__error" role="alert" data-testid="mecmua-subscribe-error">
					{error}
				</p>
			) : null}
		</div>
	);
}
