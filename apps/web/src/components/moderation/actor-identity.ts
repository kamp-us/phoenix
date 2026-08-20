// One shared handle rule across every moderation/admin surface — see ADR 0147.
export function actorLabel(
	displayName: string | null,
	username: string | null,
	fallback: string,
): string {
	if (displayName?.trim()) return displayName.trim();
	if (username?.trim()) return `@${username.trim()}`;
	return fallback;
}
