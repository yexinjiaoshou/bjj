ALTER TABLE sync_entity_versions ADD COLUMN payload_json TEXT;

UPDATE sync_entity_versions
SET payload_json = (
    SELECT journal.payload_json
    FROM sync_journal AS journal
    WHERE journal.entity_type = sync_entity_versions.entity_type
      AND journal.entity_id = sync_entity_versions.entity_id
      AND journal.hlc_physical_ms = sync_entity_versions.hlc_physical_ms
      AND journal.hlc_logical_counter = sync_entity_versions.hlc_logical_counter
      AND journal.origin_device_id = sync_entity_versions.origin_device_id
    ORDER BY journal.sequence DESC
    LIMIT 1
)
WHERE is_deleted = 0;

CREATE TABLE sync_peer_cursors (
    peer_device_id TEXT NOT NULL,
    cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('pulled', 'acknowledged')),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (peer_device_id, cursor_kind)
);