/**
 * `ProfileHeader` — the shared, presentational profile-header primitive (#2203):
 * avatar (image-or-initials) + display name + `@handle`{+ standing} + the canonical
 * activity tiles. Consumed by BOTH the owner's self-service `/profile`
 * (`ProfilePage`) and the public `/u/:username` (`UserProfileHeader`), which
 * previously hand-derived two headers that drifted (two stat orders, a standing
 * badge on one but not the other). This component owns the DOM; each surface only
 * maps its own data source (imperative `useMe`/`useProfileStats` on `/profile`, the
 * fate `Profile` view on `/u/`) into these plain props.
 *
 * The activity-tile order is the single source `profileStatTiles`; `karma` is the
 * optional flag-gated tile (`showKarma`, the `PHOENIX_AUTHORSHIP_LOOP` seam),
 * rendered via the shared `Karma` atom and kept structurally last. `standingLabel`
 * is likewise optional (owner-only — the public view has no viewed-user tier), so a
 * `null` renders handle-only, exactly as before.
 */
import {Karma} from "../karma/Karma";
import {profileStatTiles} from "./profileStatTiles";
import "./ProfileHeader.css";

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

export interface ProfileHeaderStats {
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
	readonly totalKarma: number;
}

export interface ProfileHeaderProps {
	readonly displayName: string;
	readonly handle: string;
	/** Owner-only trusted-tier subtitle; `null`/absent ⇒ handle-only. */
	readonly standingLabel?: string | null;
	/** Avatar image; falls back to display-name initials when absent. */
	readonly image?: string | null;
	/** Activity + karma counts. `null` renders the tiles as an error strip. */
	readonly stats: ProfileHeaderStats | null;
	/** A failed stats read — renders the error strip, never a misleading `0` (#448). */
	readonly statsError?: boolean;
	/** Emit the karma tile — gated by `PHOENIX_AUTHORSHIP_LOOP` on `/profile`. */
	readonly showKarma?: boolean;
}

export function ProfileHeader({
	displayName,
	handle,
	standingLabel = null,
	image = null,
	stats,
	statsError = false,
	showKarma = false,
}: ProfileHeaderProps) {
	const tiles = profileStatTiles(stats ?? {definitionCount: 0, postCount: 0, commentCount: 0});

	return (
		<header className="kp-profile-header">
			<div className="kp-profile-header__avatar" aria-hidden>
				{image ? <img src={image} alt="" /> : <span>{initialsOf(displayName)}</span>}
			</div>
			<div className="kp-profile-header__id">
				<div className="kp-profile-header__name" data-testid="user-profile-display-name">
					{displayName}
				</div>
				<div className="kp-profile-header__handle" data-testid="user-profile-handle">
					{standingLabel ? `@${handle} · ${standingLabel}` : `@${handle}`}
				</div>
			</div>
			{statsError ? (
				<div
					className="kp-profile-header__stats kp-profile-header__stats--error"
					data-testid="stats-error"
					role="alert"
				>
					istatistikler yüklenemedi
				</div>
			) : (
				<div className="kp-profile-header__stats" data-testid="user-profile-stats">
					{tiles.map((tile) => (
						<div className="kp-profile-header__stat" data-testid={tile.testId} key={tile.key}>
							<div className="n">{tile.value}</div>
							<div className="l">{tile.label}</div>
						</div>
					))}
					{showKarma ? (
						<Karma variant="stat" value={stats?.totalKarma ?? 0} testId="stat-karma" />
					) : null}
				</div>
			)}
		</header>
	);
}
