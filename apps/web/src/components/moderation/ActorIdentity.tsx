/**
 * `ActorIdentity` — the shared moderation/admin **actor row**: an actor's handle plus
 * their karma-on-others, the one primitive every mod surface renders to answer "who is
 * this actor?" (ADR 0145, grounded in the actor-centric spine of ADR 0138).
 *
 * It is the canonical home for the actor/user row across surfaces: divan's roster and
 * çaylak-detail consume it today (via the thin divan-flavoured `CaylakIdentity`
 * wrapper), and the admin user-list (#968) consumes it next — instead of each forking
 * its own handle+karma tree. The label is resolved DOM-free by {@link actorLabel}, and
 * the karma value rides the SAME reusable {@link Karma} atom (#1208) the topbar and
 * profile use.
 *
 * Presentational only: the caller passes already-resolved identity fields (a batched
 * read resolves them with no per-row by-id fetch — ADR 0021's no-waterfalls contract).
 * The class + testId tokens are props so a consuming surface keeps its own CSS
 * namespace (divan uses `kp-divan__*`) while sharing this render.
 */
import {Karma} from "../karma/Karma";
import {actorLabel} from "./actor-identity";

export interface ActorIdentityProps {
	readonly authorId: string;
	readonly displayName: string | null;
	readonly username: string | null;
	readonly totalKarma: number;
	/** Fallback handle when both name + username are blank (e.g. a deleted profile). */
	readonly fallbackLabel: string;
	readonly showKarma?: boolean;
	/** CSS class on the identity wrapper `<span>` — the consuming surface's namespace. */
	readonly identityClassName?: string;
	readonly handleClassName?: string;
	readonly karmaClassName?: string;
	/** Karma atom test-id prefix; the atom's testId becomes `${karmaTestIdPrefix}${authorId}`. */
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
