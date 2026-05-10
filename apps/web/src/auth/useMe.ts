/**
 * Hook around the `me` GraphQL query. Pasaport's session contains the user
 * id/email/name/image but the `username` additional field doesn't always
 * round-trip through Better Auth's session inference reliably right after a
 * setUsername write — so we read the canonical row through the worker's own
 * RPC into Pasaport (`stub.getUserById`) via `me`. Refetches when the auth
 * client's session updates.
 */
import {useCallback, useEffect, useState} from "react";
import {gqlFetch} from "../graphql/client";
import {useSession} from "./client";

export interface MeUser {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

interface MeQueryResponse {
	me: MeUser | null;
}

const ME_QUERY = `
	query Me {
		me {
			id
			email
			name
			image
			username
		}
	}
`;

export function useMe(): {
	me: MeUser | null;
	loading: boolean;
	refetch: () => Promise<void>;
} {
	const session = useSession();
	const [me, setMe] = useState<MeUser | null>(null);
	const [loading, setLoading] = useState(false);

	const refetch = useCallback(async () => {
		if (!session.data) {
			setMe(null);
			return;
		}
		setLoading(true);
		try {
			const result = await gqlFetch<MeQueryResponse>(ME_QUERY);
			setMe(result.me);
		} catch (err) {
			console.error("[useMe]", err);
		} finally {
			setLoading(false);
		}
	}, [session.data]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return {me, loading, refetch};
}
