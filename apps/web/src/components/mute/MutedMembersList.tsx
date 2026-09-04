// No flag check here: `mute.listMine` is flag-gated server-side and `MutesPage` self-gates
// the whole route, so this only ever renders on the on-path.

import {Button, EmptyState} from "@kampus/design";
import {VolumeX} from "lucide-react";
import {useState} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {MutedMember} from "../../../worker/features/fate/views";
import {useT} from "../../i18n";
import {Icon} from "../Icon";
import {actorLabel} from "../moderation/actor-identity";
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
	const t = useT();
	const result = useRequest({
		"mute.listMine": {list: MutedMemberConnectionView, args: {first: MUTES_PAGE_SIZE}},
	});
	const [items] = useListView(MutedMemberConnectionView, result["mute.listMine"]);

	if (items.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={VolumeX} size={24} />}
				title={t("mute.empty.title")}
				description={t("mute.empty.description")}
			/>
		);
	}

	return (
		<ul className="kp-mute-list" aria-label={t("mute.list.label")} data-testid="mute-list">
			{items.map(({node}) => (
				<MutedMemberRow key={node.id} node={node} />
			))}
		</ul>
	);
}

function MutedMemberRow({node}: {readonly node: ViewRef<"MutedMember">}) {
	const t = useT();
	const data = useView(MutedMemberRowView, node);
	const {unmute} = useMemberMute();
	const [busy, setBusy] = useState(false);
	const [removed, setRemoved] = useState(false);
	const label = actorLabel(
		data.displayName ?? null,
		data.username ?? null,
		t("mute.member.fallback"),
	);

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
				aria-label={t("mute.unmute.label", {member: label})}
			>
				{t("mute.unmute")}
			</Button>
		</li>
	);
}
