/**
 * The `FlagGate` is load-bearing, not cosmetic: with the default-off flag off, nothing renders
 * and no roster request fires, so this surface ships dark until a human flips it (ADR 0083).
 * It is the client half of a two-gate contract — the worker half fails the invisible `Denied`.
 */

import {Button, Input} from "@kampus/design";
import {Suspense, useState} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {UserAdmin} from "../../../worker/features/fate/views";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_USER_ADMIN, PHOENIX_USER_ROLE_ASSIGN} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {useLocale, useT} from "../../i18n";
import "./KullanicilarPanel.css";
import {banLabelKey, createdAtLabel, hasCreatedAt, roleLabelKey} from "./kullanicilar";
import {RoleControls} from "./RoleControls";

const ROSTER_PAGE_SIZE = 50;

const UserAdminRowView = view<UserAdmin>()({
	id: true,
	username: true,
	email: true,
	role: true,
	banned: true,
	tier: true,
	createdAt: true,
});

const UserAdminConnectionView = {items: {node: UserAdminRowView}} as const;

export default function KullanicilarPanel() {
	return (
		<FlagGate flag={PHOENIX_USER_ADMIN}>
			<KullanicilarRoster />
		</FlagGate>
	);
}

function KullanicilarRoster() {
	const t = useT();
	// The applied search is separate from the draft so a keystroke doesn't refetch the roster.
	const [draft, setDraft] = useState("");
	const [applied, setApplied] = useState("");
	// Bumped after a role assignment to remount RosterList and force a fresh network-only
	// re-read. A `RoleState` write doesn't touch the `UserAdmin` entity in the store, so the
	// row can't self-update — the re-read is what reflects it.
	const [reloadNonce, setReloadNonce] = useState(0);

	function onSubmit(event: React.FormEvent) {
		event.preventDefault();
		setApplied(draft.trim());
	}

	return (
		<section
			className="kp-kullanicilar"
			aria-label={t("admin.kullanicilar.label")}
			data-testid="kullanicilar-panel"
		>
			<form
				className="kp-kullanicilar__search"
				onSubmit={onSubmit}
				aria-label={t("admin.kullanicilar.search.form")}
			>
				<Input
					className="kp-kullanicilar__field kp-kullanicilar__search-input"
					label={t("admin.kullanicilar.search.label")}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder={t("admin.kullanicilar.search.placeholder")}
					data-testid="kullanicilar-search-input"
				/>
				<Button
					variant="secondary"
					size="sm"
					type="submit"
					data-testid="kullanicilar-search-button"
				>
					{t("admin.kullanicilar.search.submit")}
				</Button>
			</form>
			<Suspense
				fallback={<p className="kp-kullanicilar__loading">{t("admin.kullanicilar.loading")}</p>}
			>
				<RosterList
					key={reloadNonce}
					search={applied}
					onRoleChanged={() => setReloadNonce((n) => n + 1)}
				/>
			</Suspense>
		</section>
	);
}

function RosterList({
	search,
	onRoleChanged,
}: {
	readonly search: string;
	readonly onRoleChanged: () => void;
}) {
	const t = useT();
	// Read once here so the whole column — header and cells — appears or disappears as a unit:
	// flag off means no action column at all, not an empty one.
	const {value: roleAssignOn} = useFlag(PHOENIX_USER_ROLE_ASSIGN, false);
	const result = useRequest(
		{
			"userAdmin.list": {
				list: UserAdminConnectionView,
				args: {first: ROSTER_PAGE_SIZE, ...(search ? {search} : {})},
			},
		},
		{mode: "network-only"},
	);
	const [items] = useListView(UserAdminConnectionView, result["userAdmin.list"]);

	if (items.length === 0) {
		return (
			<p className="kp-kullanicilar__empty" data-testid="kullanicilar-empty">
				{search ? t("admin.kullanicilar.empty.search") : t("admin.kullanicilar.empty.all")}
			</p>
		);
	}

	return (
		<table className="kp-kullanicilar__table" data-testid="kullanicilar-table">
			<caption className="kp-kullanicilar__caption">{t("admin.kullanicilar.caption")}</caption>
			<thead>
				<tr>
					<th scope="col">{t("admin.kullanicilar.column.username")}</th>
					<th scope="col">{t("admin.kullanicilar.column.email")}</th>
					<th scope="col">{t("admin.kullanicilar.column.role")}</th>
					<th scope="col">{t("admin.kullanicilar.column.status")}</th>
					<th scope="col">{t("admin.kullanicilar.column.tier")}</th>
					<th scope="col">{t("admin.kullanicilar.column.createdAt")}</th>
					{roleAssignOn ? <th scope="col">{t("admin.kullanicilar.column.roleActions")}</th> : null}
				</tr>
			</thead>
			<tbody>
				{items.map(({node}) => (
					<RosterRow
						key={node.id}
						node={node}
						roleAssignOn={roleAssignOn}
						onRoleChanged={onRoleChanged}
					/>
				))}
			</tbody>
		</table>
	);
}

function RosterRow({
	node,
	roleAssignOn,
	onRoleChanged,
}: {
	readonly node: ViewRef<"UserAdmin">;
	readonly roleAssignOn: boolean;
	readonly onRoleChanged: () => void;
}) {
	const t = useT();
	const {locale} = useLocale();
	const data = useView(UserAdminRowView, node);
	return (
		<tr data-testid={`kullanicilar-row-${data.id}`}>
			<td className="kp-kullanicilar__username">
				{data.username ?? t("admin.kullanicilar.username.unset")}
			</td>
			<td>{data.email}</td>
			<td>{t(roleLabelKey(data.role))}</td>
			<td data-testid={`kullanicilar-ban-${data.id}`}>{t(banLabelKey(data.banned))}</td>
			<td>{data.tier}</td>
			<td>
				{hasCreatedAt(data.createdAt)
					? createdAtLabel(data.createdAt, locale)
					: t("admin.kullanicilar.createdAt.unknown")}
			</td>
			{roleAssignOn ? (
				<td className="kp-kullanicilar__actions">
					<RoleControls userId={data.id} platformRole={data.role} onRoleChanged={onRoleChanged} />
				</td>
			) : null}
		</tr>
	);
}
