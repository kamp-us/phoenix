/**
 * The per-recipient live notification channel's identity (#1700). A leaf module —
 * a pure string constant with no fate-view / Drizzle deps — so BOTH the publish
 * seam (`Notification.publishChannel`) and the subscribe-authorization gate
 * (`fate-live/route.ts`) name the SAME entity type without either pulling the
 * other's graph. The channel is keyed by the recipient's user id; the route
 * rejects an entity subscription to this type whose id is not the session user's.
 */

/** The fate entity type the live unread signal fans out on — keyed by recipient id. */
export const NOTIFICATION_CHANNEL_TYPE = "NotificationChannel";
