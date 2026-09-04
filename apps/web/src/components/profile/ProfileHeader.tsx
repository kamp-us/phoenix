/**
 * The one presentational profile header, owning the DOM for BOTH the owner's
 * `/profile` and the public `/u/:username`. Each surface only maps its own data
 * source into these plain props — the two used to hand-derive headers that drifted
 * apart (#2203).
 */
import {useT} from "../../i18n";
import {Karma} from "../karma/Karma";
import {Alert} from "../ui/Alert";
import {Avatar} from "../ui/Avatar";
import {profileStatTiles} from "./profileStatTiles";
import "./ProfileHeader.css";

export interface ProfileHeaderStats {
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
	readonly totalKarma: number;
}

export interface ProfileHeaderProps {
	readonly displayName: string;
	readonly handle: string;
	readonly standingLabel?: string | null;
	readonly image?: string | null;
	readonly stats: ProfileHeaderStats | null;
	/** A failed stats read renders the error strip, never a misleading `0` (#448). */
	readonly statsError?: boolean;
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
	const t = useT();
	const tiles = profileStatTiles(stats ?? {definitionCount: 0, postCount: 0, commentCount: 0});

	return (
		<header className="kp-profile-header">
			<div className="kp-profile-header__avatar-wrap" aria-hidden="true">
				<Avatar
					name={displayName}
					src={image ?? undefined}
					size="xl"
					className="kp-profile-header__avatar"
				/>
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
				<Alert
					variant="danger"
					className="kp-alert--inline kp-profile-header__stats kp-profile-header__stats--error"
					data-testid="stats-error"
				>
					{t("profile.header.statsError")}
				</Alert>
			) : (
				<div className="kp-profile-header__stats" data-testid="user-profile-stats">
					{tiles.map((tile) => (
						<div className="kp-profile-header__stat" data-testid={tile.testId} key={tile.key}>
							<div className="n">{tile.value}</div>
							<div className="l">{t(tile.labelKey)}</div>
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
