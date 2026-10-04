/**
 * The one presentational profile header, owning the DOM for BOTH the owner's
 * `/profile` and the public `/u/:username`. Each surface only maps its own data
 * source into these plain props — the two used to hand-derive headers that drifted
 * apart (#2203).
 */

import {Alert, Avatar, Skeleton} from "@kampus/design";
import {type CatalogKey, useT} from "../../i18n";
import {Karma} from "../karma/Karma";
import {profileStatTiles} from "./profileStatTiles";
import "./ProfileHeader.css";

export interface ProfileHeaderStats {
	readonly definitionCount: number;
	readonly postCount: number;
	readonly commentCount: number;
	readonly totalKarma: number;
}

/**
 * One discriminated prop rather than `stats: … | null` beside a `statsError` flag: that pair
 * spelled "the read is in flight" and "this user has zero activity" the same way, and the
 * header resolved the ambiguity as real zero counts (#9265). A read that has not answered
 * carries no counts, and this type is where that is said.
 */
export type ProfileHeaderStatsState =
	| {readonly status: "loading"}
	| {readonly status: "error"}
	| {readonly status: "ready"; readonly stats: ProfileHeaderStats};

export interface ProfileHeaderProps {
	readonly displayName: string;
	readonly handle: string;
	readonly standingLabel?: string | null;
	readonly image?: string | null;
	/** `error` renders the strip's alert, `loading` its placeholders — never a misleading `0` (#448). */
	readonly stats: ProfileHeaderStatsState;
	readonly showKarma?: boolean;
}

// The tile's own geometry with the number withheld. Not a Karma/tile primitive in a loading
// mode — neither has one — so it borrows the rendered tile's classes to reserve exactly the
// height the counts land at, which is what keeps the strip from shifting when they do.
function StatPlaceholder({labelKey}: {labelKey: CatalogKey}) {
	const t = useT();
	return (
		<div className="kp-profile-header__stat">
			<div className="n">
				<Skeleton width={24} height="1em" />
			</div>
			<div className="l">{t(labelKey)}</div>
		</div>
	);
}

export function ProfileHeader({
	displayName,
	handle,
	standingLabel = null,
	image = null,
	stats,
	showKarma = false,
}: ProfileHeaderProps) {
	const t = useT();

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
			{stats.status === "error" ? (
				<Alert
					variant="danger"
					className="kp-alert--inline kp-profile-header__stats kp-profile-header__stats--error"
					data-testid="stats-error"
				>
					{t("profile.header.statsError")}
				</Alert>
			) : stats.status === "loading" ? (
				// `role="status"` + `aria-label`, so a screen reader hears one "counts are
				// loading" instead of the labels with nothing read out beside them.
				<div
					className="kp-profile-header__stats"
					data-testid="stats-loading"
					role="status"
					aria-busy="true"
					aria-label={t("profile.header.statsLoading")}
				>
					<StatPlaceholder labelKey="profile.stat.definitions" />
					<StatPlaceholder labelKey="profile.stat.posts" />
					<StatPlaceholder labelKey="profile.stat.comments" />
					{showKarma ? <StatPlaceholder labelKey="karma.label" /> : null}
				</div>
			) : (
				<div className="kp-profile-header__stats" data-testid="user-profile-stats">
					{profileStatTiles(stats.stats).map((tile) => (
						<div className="kp-profile-header__stat" data-testid={tile.testId} key={tile.key}>
							<div className="n">{tile.value}</div>
							<div className="l">{t(tile.labelKey)}</div>
						</div>
					))}
					{showKarma ? (
						<Karma variant="stat" value={stats.stats.totalKarma} testId="stat-karma" />
					) : null}
				</div>
			)}
		</header>
	);
}
