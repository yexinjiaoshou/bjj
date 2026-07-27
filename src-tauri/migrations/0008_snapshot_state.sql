ALTER TABLE sync_entity_versions ADD COLUMN winning_change_id TEXT;

UPDATE sync_entity_versions
SET winning_change_id = (
    SELECT journal.change_id
    FROM sync_journal AS journal
    WHERE journal.entity_type = sync_entity_versions.entity_type
      AND journal.entity_id = sync_entity_versions.entity_id
      AND journal.hlc_physical_ms = sync_entity_versions.hlc_physical_ms
      AND journal.hlc_logical_counter = sync_entity_versions.hlc_logical_counter
      AND journal.origin_device_id = sync_entity_versions.origin_device_id
    ORDER BY journal.sequence DESC
    LIMIT 1
);

CREATE UNIQUE INDEX sync_entity_versions_winning_change_idx
    ON sync_entity_versions(winning_change_id)
    WHERE winning_change_id IS NOT NULL;

CREATE TRIGGER sync_entity_versions_require_change_id_insert
BEFORE INSERT ON sync_entity_versions
WHEN NEW.winning_change_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'sync winner change ID is required');
END;

CREATE TRIGGER sync_entity_versions_require_change_id_update
BEFORE UPDATE OF winning_change_id ON sync_entity_versions
WHEN NEW.winning_change_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'sync winner change ID is required');
END;

INSERT OR IGNORE INTO sync_store_meta (key, value)
VALUES ('journal_floor', '0');