/**
 * `MutedMembersList` — the manage-my-mutes surface (#3117, epic #2035): one row per member
 * the viewer has muted, off the `CurrentUser`-scoped `mute.listMine` read model (#3114),
 * newest-first, each row offering a per-row "geri al" (unmute). The `mute.listMine` read is
 * flag-gated server-side (off ⇒ the invisible `MUTE_DISABLED`, caught by the page's
 * `<Screen>`), so this only ever renders under the on-path; the page (`MutesPage`) self-gates
 * the whole route on `member-mute`.
 *
 * Unmuting drives {@link useMemberMute} (which also clears the feed overlay) and drops the row
 * locally on success, so the list reflects the change without a refetch.
 *
 * a11y: a real `<ul>`, the member handle as text, the empty state as a composed treatment
 * (never a bare void), lowercase Turkish copy.
 */

import {VolumeX} from "lucide-react";
import {useState} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {MutedMember} from "../../../worker/features/fate/views";
import {Icon} from "../Icon";
import {actorLabel} from "../moderation/actor-identity";
import {Button} from "../ui/Button";
import {EmptyState} from "../ui/EmptyState";
import {useMemberMute} from "./useMemberMute";
import "./MutedMembersList.css";

const MUTES_PAGE_SIZE = 50;

const MutedMemberRowView = view<MutedMember>()({
	id: true,
	username: true,
	displayName: true,
	mutedAt: true,
});

const MutedMemberConnectionView = {items: {node: MutedMemberRowView}} as const;

export function MutedMembersList() {
	const result = useRequest({
		"mute.listMine": {list: MutedMemberConnectionView, args: {first: MUTES_PAGE_SIZE}},
	});
	const [items] = useListView(MutedMemberConnectionView, result["mute.listMine"]);

	if (items.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={VolumeX} size={24} />}
				title="henüz kimseyi susturmadın"
				description="susturduğun üyeler burada listelenir; buradan sessizliği geri alabilirsin."
			/>
		);
	}

	return (
		<ul className="kp-mute-list" aria-label="susturduğun üyeler" data-testid="mute-list">
			{items.map(({node}) => (
				<MutedMemberRow key={node.id} node={node} />
			))}
		</ul>
	);
}

function MutedMemberRow({node}: {readonly node: ViewRef<"MutedMember">}) {
	const data = useView(MutedMemberRowView, node);
	const {unmute} = useMemberMute();
	const [busy, setBusy] = useState(false);
	const [removed, setRemoved] = useState(false);
	const label = actorLabel(data.displayName ?? null, data.username ?? null, "bir üye");

	if (removed) return null;

	async function onUnmute() {
		if (busy) return;
		setBusy(true);
		const {ok} = await unmute(data.id);
		if (ok) setRemoved(true);
		else setBusy(false);
	}

	return (
		<li className="kp-mute-list__row" data-testid={`mute-row-${data.id}`}>
			<span className="kp-mute-list__member">{label}</span>
			<Button
				variant="secondary"
				size="sm"
				loading={busy}
				onClick={onUnmute}
				data-testid={`mute-unmute-${data.id}`}
				aria-label={`${label} adlı üyenin sessizliğini geri al`}
			>
				geri al
			</Button>
		</li>
	);
}
