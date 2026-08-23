/**
 * `useDivanPendingCount` — the topbar divan glyph's pending-review count (#6760).
 *
 * A one-shot imperative read (`useImperativeView`) because it mounts in the `Layout`
 * shell above any `<Screen>` Suspense boundary. Deliberately NOT a live subscription
 * (#6760): the badge is a pull-the-yazar nudge, not a queue meter, so it re-reads on
 * navigation like the rest of the chips. Enabled only once `useDivanAccess` granted,
 * so the gated wire read fires only for subjects with divan standing; any denial (or
 * an unset count) fails closed to `undefined` — no number, no badge.
 */
import {view} from "react-fate";
import type {DivanPending} from "../../../worker/features/fate/views";
import {useImperativeView} from "../../fate/useImperativeView";

const DivanPendingView = view<DivanPending>()({id: true, count: true});

export function useDivanPendingCount(enabled: boolean): number | undefined {
	const {state} = useImperativeView("divan.pendingCount", DivanPendingView, {enabled});
	return state.status === "ok" ? state.data?.count : undefined;
}
