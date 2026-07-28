ALTER TABLE sync_entity_versions
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);

ALTER TABLE sync_tombstones
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);

ALTER TABLE sync_journal
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);

ALTER TABLE sync_conflicts
    ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);

ALTER TABLE sync_conflicts
    ADD COLUMN winning_generation INTEGER CHECK (
        winning_generation IS NULL OR winning_generation >= 0
    );
