PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    aliases_json TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL CHECK (category IN ('standing', 'guard', 'control', 'pin', 'submission')),
    role TEXT NOT NULL CHECK (role IN ('top', 'bottom', 'neutral')),
    side TEXT NOT NULL CHECK (side IN ('left', 'right', 'both')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    x REAL NOT NULL,
    y REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS techniques (
    id TEXT PRIMARY KEY NOT NULL,
    source_position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    target_position_id TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    gi_mode TEXT NOT NULL CHECK (gi_mode IN ('gi', 'nogi', 'both')),
    difficulty TEXT NOT NULL CHECK (difficulty IN ('foundation', 'intermediate', 'advanced')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (source_position_id <> target_position_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('position', 'technique')),
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'image', 'video', 'link')),
    title TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS techniques_source_position_idx
    ON techniques(source_position_id);
CREATE INDEX IF NOT EXISTS techniques_target_position_idx
    ON techniques(target_position_id);
CREATE INDEX IF NOT EXISTS attachments_owner_idx
    ON attachments(owner_type, owner_id, sort_order);

CREATE TRIGGER IF NOT EXISTS attachments_validate_position_insert
BEFORE INSERT ON attachments
WHEN NEW.owner_type = 'position'
    AND NOT EXISTS (SELECT 1 FROM positions WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment position owner does not exist');
END;

CREATE TRIGGER IF NOT EXISTS attachments_validate_technique_insert
BEFORE INSERT ON attachments
WHEN NEW.owner_type = 'technique'
    AND NOT EXISTS (SELECT 1 FROM techniques WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment technique owner does not exist');
END;

CREATE TRIGGER IF NOT EXISTS attachments_validate_position_update
BEFORE UPDATE OF owner_type, owner_id ON attachments
WHEN NEW.owner_type = 'position'
    AND NOT EXISTS (SELECT 1 FROM positions WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment position owner does not exist');
END;

CREATE TRIGGER IF NOT EXISTS attachments_validate_technique_update
BEFORE UPDATE OF owner_type, owner_id ON attachments
WHEN NEW.owner_type = 'technique'
    AND NOT EXISTS (SELECT 1 FROM techniques WHERE id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'attachment technique owner does not exist');
END;

CREATE TRIGGER IF NOT EXISTS positions_delete_techniques
AFTER DELETE ON positions
BEGIN
    DELETE FROM techniques
    WHERE source_position_id = OLD.id OR target_position_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS positions_delete_attachments
AFTER DELETE ON positions
BEGIN
    DELETE FROM attachments
    WHERE owner_type = 'position' AND owner_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS techniques_delete_attachments
AFTER DELETE ON techniques
BEGIN
    DELETE FROM attachments
    WHERE owner_type = 'technique' AND owner_id = OLD.id;
END;