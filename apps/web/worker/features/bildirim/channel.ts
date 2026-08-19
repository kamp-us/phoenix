/**
 * The per-recipient live notification channel's identity (#1700). A leaf module — a pure string
 * constant, no fate-view / Drizzle deps — so the publish seam and the subscribe-authorization
 * gate name the SAME entity type without either pulling the other's graph. Keyed by recipient id;
 * the route rejects a subscription to this type whose id is not the session user's.
 */

export const NOTIFICATION_CHANNEL_TYPE = "NotificationChannel";
