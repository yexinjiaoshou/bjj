CREATE TABLE sync_conflicts (
    change_id TEXT PRIMARY KEY NOT NULL,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('position', 'position_layout', 'technique', 'attachment')
    ),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
    hlc_logical_counter INTEGER NOT NULL CHECK (hlc_logical_counter >= 0),
    origin_device_id TEXT NOT NULL,
    payload_json TEXT,
    reason TEXT NOT NULL CHECK (
        reason IN ('older_revision', 'deleted_entity', 'deleted_dependency')
    ),
    blocking_entity_type TEXT CHECK (
        blocking_entity_type IS NULL
        OR blocking_entity_type IN ('position', 'position_layout', 'technique', 'attachment')
    ),
    blocking_entity_id TEXT,
    winning_hlc_physical_ms INTEGER CHECK (
        winning_hlc_physical_ms IS NULL OR winning_hlc_physical_ms >= 0
    ),
    winning_hlc_logical_counter INTEGER CHECK (
        winning_hlc_logical_counter IS NULL OR winning_hlc_logical_counter >= 0
    ),
    winning_origin_device_id TEXT,
    recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (blocking_entity_type IS NULL AND blocking_entity_id IS NULL)
        OR (blocking_entity_type IS NOT NULL AND blocking_entity_id IS NOT NULL)
    )
);

CREATE INDEX sync_conflicts_entity_idx ON sync_conflicts (
    entity_type,
    entity_id,
    recorded_at
);