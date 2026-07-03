/**
 * `useBildirimUnread` — the topbar badge's unread-count read (#1694): the
 * `bildirim.unreadCount` synthetic singleton over the imperative
 * `useImperativeView` (the `useProfileStats` shape — the badge renders in the
 * `Layout` shell above any `<Screen>` boundary, so it must drive fate itself
 * rather than suspend). Disabled (flag off / signed out) or failed reads report
 * 0, so the badge simply doesn't render — the safe/off path.
 */
import {view} from "react-fate";
import type {NotificationUnread} from "../../../worker/features/fate/views";
import {useImperativeView} from "../../fate/useImperativeView";

const UnreadView = view<NotificationUnread>()({
	id: true,
	count: true,
});

export function useBildirimUnread(enabled: boolean): number {
	const {state} = useImperativeView("bildirim.unreadCount", UnreadView, {enabled});
	return state.status === "ok" ? (state.data?.count ?? 0) : 0;
}
