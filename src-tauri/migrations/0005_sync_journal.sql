CREATE TABLE sync_hlc_state (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    physical_ms INTEGER NOT NULL CHECK (physical_ms >= 0),
    logical_counter INTEGER NOT NULL CHECK (logical_counter >= 0)
);

INSERT INTO sync_hlc_state (singleton, physical_ms, logical_counter)
VALUES (1, 0, 0);

CREATE TABLE sync_store_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE sync_entity_versions (
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('position', 'position_layout', 'technique', 'attachment')
    ),
    entity_id TEXT NOT NULL,
    hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
    hlc_logical_counter INTEGER NOT NULL CHECK (hlc_logical_counter >= 0),
    origin_device_id TEXT NOT NULL,
    is_deleted INTEGER NOT NULL CHECK (is_deleted IN (0, 1)),
    PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE sync_tombstones (
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('position', 'position_layout', 'technique', 'attachment')
    ),
    entity_id TEXT NOT NULL,
    hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
    hlc_logical_counter INTEGER NOT NULL CHECK (hlc_logical_counter >= 0),
    origin_device_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE sync_journal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL CHECK (
        entity_type IN ('position', 'position_layout', 'technique', 'attachment')
    ),
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
    hlc_logical_counter INTEGER NOT NULL CHECK (hlc_logical_counter >= 0),
    origin_device_id TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (operation = 'upsert' AND payload_json IS NOT NULL)
        OR (operation = 'delete' AND payload_json IS NULL)
    )
);

CREATE INDEX sync_journal_hlc_idx ON sync_journal (
    hlc_physical_ms,
    hlc_logical_counter,
    origin_device_id,
    sequence
);

CREATE INDEX sync_journal_entity_idx ON sync_journal (
    entity_type,
    entity_id,
    sequence
);