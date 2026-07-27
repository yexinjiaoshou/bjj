ALTER TABLE attachments ADD COLUMN blob_hash TEXT
    CHECK (blob_hash IS NULL OR length(blob_hash) = 64);
ALTER TABLE attachments ADD COLUMN mime_type TEXT;
ALTER TABLE attachments ADD COLUMN file_extension TEXT
    CHECK (file_extension IS NULL OR length(file_extension) BETWEEN 1 AND 16);
ALTER TABLE attachments ADD COLUMN byte_size INTEGER
    CHECK (byte_size IS NULL OR byte_size >= 0);

CREATE INDEX attachments_blob_hash_idx
    ON attachments(blob_hash)
    WHERE blob_hash IS NOT NULL;

CREATE TABLE media_blobs (
    blob_hash TEXT PRIMARY KEY NOT NULL CHECK (length(blob_hash) = 64),
    relative_path TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    file_extension TEXT NOT NULL CHECK (length(file_extension) BETWEEN 1 AND 16),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);