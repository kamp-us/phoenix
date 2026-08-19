// This hook holds no flag; consumers gate on the default-off `member-mute` flag first.
//
// A rejected mutation THROWS rather than returning `{error}` (phoenix wire codes are
// boundary-class — see `.patterns/fate-mutations-client.md`), so both the `{error}` return
// and the catch below are live paths and both must roll the overlay back.
import {useCallback, useSyncExternalStore} from "react";
import {useFateClient, view} from "react-fate";
import type {MuteReceipt} from "../../../worker/features/fate/views";
import {muteStoreSnapshot, setMemberMuted, subscribeMuteStore} from "./muteStore";

const MuteReceiptView = view<MuteReceipt>()({
	id: true,
	isMuted: true,
	changed: true,
});

export function useMutedMembers(): {
	readonly isMuted: (id: string) => boolean;
	readonly mutedIds: ReadonlySet<string>;
} {
	const mutedIds = useSyncExternalStore(subscribeMuteStore, muteStoreSnapshot, muteStoreSnapshot);
	const isMuted = useCallback((id: string) => mutedIds.has(id), [mutedIds]);
	return {isMuted, mutedIds};
}

export function useMemberMute(): {
	readonly mute: (memberId: string) => Promise<{readonly ok: boolean}>;
	readonly unmute: (memberId: string) => Promise<{readonly ok: boolean}>;
} {
	const fate = useFateClient();

	const mute = useCallback(
		async (memberId: string) => {
			setMemberMuted(memberId, true);
			try {
				const {error} = await fate.mutations.mute.set({
					input: {mutedId: memberId},
					view: MuteReceiptView,
				});
				if (error) {
					setMemberMuted(memberId, false);
					return {ok: false};
				}
				return {ok: true};
			} catch {
				setMemberMuted(memberId, false);
				return {ok: false};
			}
		},
		[fate],
	);

	const unmute = useCallback(
		async (memberId: string) => {
			setMemberMuted(memberId, false);
			try {
				const {error} = await fate.mutations.mute.remove({
					input: {mutedId: memberId},
					view: MuteReceiptView,
				});
				if (error) {
					setMemberMuted(memberId, true);
					return {ok: false};
				}
				return {ok: true};
			} catch {
				setMemberMuted(memberId, true);
				return {ok: false};
			}
		},
		[fate],
	);

	return {mute, unmute};
}
