// Gating mirrors the mutations: signed-in only, NOT tier-gated (a çaylak may follow),
// unlike publishing. Dark until a human flips `MECMUA_FEED` at release (ADR 0083).

import {Alert, Button} from "@kampus/design";
import {useMemo, useState} from "react";
import {useFateClient, view} from "react-fate";
import type {MecmuaSubscriptionReceipt} from "../../../worker/features/fate/views";
import {useSession} from "../../auth/client";
import {useMe} from "../../auth/useMe";
import {useImperativeView} from "../../fate/useImperativeView";
import {MECMUA_FEED} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {type CatalogKey, useT} from "../../i18n";
import "./MecmuaSubscribeButton.css";

const SubscriptionView = view<MecmuaSubscriptionReceipt>()({
	id: true,
	subscribed: true,
});

/** The key, not the copy: the label is one catalog read at the render site. */
export function mecmuaSubscribeLabelKey(subscribed: boolean, hovering: boolean): CatalogKey {
	if (!subscribed) return "mecmua.subscribe.subscribe";
	return hovering ? "mecmua.subscribe.leave" : "mecmua.subscribe.following";
}

export function MecmuaSubscribeButton({authorId}: {authorId: string}) {
	const {value: feedOn, loading: flagLoading} = useFlag(MECMUA_FEED, false);
	const session = useSession();
	const {me} = useMe();

	if (flagLoading || !feedOn || !session.data) return null;
	if (me?.id === authorId) return null;

	return <MecmuaSubscribeToggle authorId={authorId} />;
}

function MecmuaSubscribeToggle({authorId}: {authorId: string}) {
	const fate = useFateClient();
	const t = useT();
	const args = useMemo(() => ({authorId}), [authorId]);
	const {state, refetch} = useImperativeView("mecmuaSubscription", SubscriptionView, {
		args,
		enabled: true,
	});

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hovering, setHovering] = useState(false);

	// Don't render a guessy control until the initial edge state resolves, or the button
	// would flash the subscribe label for a reader who already follows this author.
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
					t(subscribed ? "mecmua.subscribe.error.unsubscribe" : "mecmua.subscribe.error.subscribe"),
				);
				return;
			}
			await refetch();
		} catch {
			setError(t("mecmua.subscribe.error.generic"));
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
				{t(mecmuaSubscribeLabelKey(subscribed, hovering))}
			</Button>
			{error ? (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-mecmua-subscribe__error"
					data-testid="mecmua-subscribe-error"
				>
					{error}
				</Alert>
			) : null}
		</div>
	);
}
