/**
 * The client seam for member-mute (sustur, #3117): the muted-set read and the mute/unmute
 * dispatch. Consumers gate on the default-off `member-mute` flag first — this hook holds no
 * flag, only the fate write + the optimistic overlay ({@link muteStore}).
 *
 * `mute` / `unmute` write the overlay OPTIMISTICALLY, dispatch the `mute.set` / `mute.remove`
 * fate mutation, and ROLL BACK on failure. Phoenix wire codes are boundary-class, so a
 * rejected mutation THROWS rather than returning `{error}` (see
 * `.patterns/fate-mutations-client.md`); both branches are handled — the `{error}` return and
 * the throw — and either rolls the overlay back.
 */
import {useCallback, useSyncExternalStore} from "react";
import {useFateClient, view} from "react-fate";
import type {MuteReceipt} from "../../../worker/features/fate/views";
import {muteStoreSnapshot, setMemberMuted, subscribeMuteStore} from "./muteStore";

/** The `mute.set` / `mute.remove` write-back selection — the presence receipt. */
const MuteReceiptView = view<MuteReceipt>()({
	id: true,
	isMuted: true,
	changed: true,
});

/** The current muted set + an `isMuted` predicate, re-rendering on any overlay change. */
export function useMutedMembers(): {
	readonly isMuted: (id: string) => boolean;
	readonly mutedIds: ReadonlySet<string>;
} {
	const mutedIds = useSyncExternalStore(subscribeMuteStore, muteStoreSnapshot, muteStoreSnapshot);
	const isMuted = useCallback((id: string) => mutedIds.has(id), [mutedIds]);
	return {isMuted, mutedIds};
}

/** The mute/unmute dispatch — optimistic overlay write + fate mutation + rollback on failure. */
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
