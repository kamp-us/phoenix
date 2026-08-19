// The one actor row every moderation/admin surface renders — see ADR 0147.
// Presentational only: identity fields arrive already resolved, so no row fetches
// by id (ADR 0021's no-waterfalls contract).
import {Karma} from "../karma/Karma";
import {actorLabel} from "./actor-identity";

export interface ActorIdentityProps {
	readonly authorId: string;
	readonly displayName: string | null;
	readonly username: string | null;
	readonly totalKarma: number;
	readonly fallbackLabel: string;
	readonly showKarma?: boolean;
	readonly identityClassName?: string;
	readonly handleClassName?: string;
	readonly karmaClassName?: string;
	readonly karmaTestIdPrefix?: string;
}

export function ActorIdentity({
	authorId,
	displayName,
	username,
	totalKarma,
	fallbackLabel,
	showKarma = true,
	identityClassName,
	handleClassName,
	karmaClassName,
	karmaTestIdPrefix = "karma-",
}: ActorIdentityProps) {
	const label = actorLabel(displayName, username, fallbackLabel);

	return (
		<span className={identityClassName}>
			<span className={handleClassName}>{label}</span>
			{showKarma ? (
				<Karma
					value={totalKarma}
					variant="inline"
					label="karma"
					testId={`${karmaTestIdPrefix}${authorId}`}
					className={karmaClassName}
				/>
			) : null}
		</span>
	);
}
