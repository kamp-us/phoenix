-- #108 — align the `apiKey` table with the pinned @better-auth/api-key plugin's declared
-- schema. The plugin's `apikey` model requires a `configId` field (default 'default'); its
-- drizzle adapter's `checkMissingFields` indexes the table by the plugin's field names on
-- every create, so a key mint 500s without this column. `reference_id` needs no rename: the
-- plugin field `referenceId` maps to the existing `user_id` column at the drizzle-property
-- level (default user-references config → the reference IS the user id).

ALTER TABLE `apiKey` ADD `config_id` text DEFAULT 'default' NOT NULL;
