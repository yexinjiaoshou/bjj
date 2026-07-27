DROP TRIGGER IF EXISTS attachments_validate_technique_insert;
DROP TRIGGER IF EXISTS attachments_validate_technique_update;
DROP TRIGGER IF EXISTS positions_delete_techniques;
DROP TRIGGER IF EXISTS techniques_delete_attachments;

ALTER TABLE techniques RENAME TO techniques_with_required_target;

CREATE TABLE techniques (
    id TEXT PRIMARY KEY NOT NULL,
    source_position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    target_position_id TEXT REFERENCES positions(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    gi_mode TEXT NOT NULL CHECK (gi_mode IN ('gi', 'nogi', 'both')),
    difficulty TEXT NOT NULL CHECK (difficulty IN ('foundation', 'intermediate', 'advanced')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (source_position_id <> target_position_id)
);

INSERT INTO techniques (
    id,
    source_position_id,
    target_position_id,
    name,
    description,
    gi_mode,
    difficulty,
    tags_json,
    created_at,
    updated_at
)
SELECT
    id,
    source_position_id,
    target_position_id,
    name,
    description,
    gi_mode,
    difficulty,
    tags_json,
    created_at,
    updated_at
FROM techniques_with_required_target;

DROP TABLE techniques_with_required_target;

CREATE INDEX techniques_source_position_idx
    ON techniques(source_position_id);
CREATE INDEX techniques_target_position_idx
    ON techniques(target_position_id);

CREATE TRIGGER attachments_validate_technique_insert
BEFORE INSERT ON attachments
WHEN NEW.owner_type = 'technique'
  AND NOT EXISTS (SELECT 1 FROM techniques WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment technique owner does not exist');
END;

CREATE TRIGGER attachments_validate_technique_update
BEFORE UPDATE OF owner_type, owner_id ON attachments
WHEN NEW.owner_type = 'technique'
  AND NOT EXISTS (SELECT 1 FROM techniques WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment technique owner does not exist');
END;

CREATE TRIGGER positions_delete_techniques
AFTER DELETE ON positions
BEGIN
    DELETE FROM techniques
    WHERE source_position_id = OLD.id OR target_position_id = OLD.id;
END;

CREATE TRIGGER techniques_delete_attachments
AFTER DELETE ON techniques
BEGIN
    DELETE FROM attachments
    WHERE owner_type = 'technique' AND owner_id = OLD.id;
END;