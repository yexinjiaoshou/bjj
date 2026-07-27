use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const CATALOG_DATABASE_FILENAME: &str = "rollmap-catalog.db";
const CATALOG_SCHEMA_VERSION: i64 = 5;

const CATALOG_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS rollmap_catalog_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS libraries (
    id TEXT PRIMARY KEY NOT NULL,
    sync_library_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    database_url TEXT NOT NULL UNIQUE,
    media_directory TEXT NOT NULL UNIQUE,
    browser_storage_key TEXT NOT NULL UNIQUE,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trusted_peers (
    device_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
    identity_public_key BLOB NOT NULL UNIQUE CHECK (length(identity_public_key) = 32),
    trusted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS trusted_peer_libraries (
    peer_device_id TEXT NOT NULL REFERENCES trusted_peers(device_id) ON DELETE CASCADE,
    sync_library_id TEXT NOT NULL REFERENCES libraries(sync_library_id) ON DELETE CASCADE,
    authorized_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TEXT,
    PRIMARY KEY (peer_device_id, sync_library_id)
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
    token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    consumed_at_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trusted_peer_endpoints (
    peer_device_id TEXT PRIMARY KEY NOT NULL REFERENCES trusted_peers(device_id) ON DELETE CASCADE,
    base_url TEXT NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS library_versions (
    sync_library_id TEXT PRIMARY KEY NOT NULL REFERENCES libraries(sync_library_id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    is_deleted INTEGER NOT NULL CHECK (is_deleted IN (0, 1)),
    hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
    hlc_logical_counter INTEGER NOT NULL CHECK (hlc_logical_counter >= 0),
    writer_device_id TEXT NOT NULL
);

INSERT OR IGNORE INTO rollmap_catalog_migrations (version, description)
VALUES (1, 'initial_catalog');

INSERT OR IGNORE INTO rollmap_catalog_migrations (version, description)
VALUES (2, 'trusted_peers');

INSERT OR IGNORE INTO rollmap_catalog_migrations (version, description)
VALUES (3, 'pairing_sessions');

INSERT OR IGNORE INTO rollmap_catalog_migrations (version, description)
VALUES (4, 'trusted_peer_endpoints');

INSERT OR IGNORE INTO rollmap_catalog_migrations (version, description)
VALUES (5, 'library_versions');
";

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRevision {
    pub physical_ms: i64,
    pub logical_counter: i64,
    pub writer_device_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLibraryRecord {
    pub sync_library_id: String,
    pub name: String,
    pub deleted: bool,
    pub revision: CatalogRevision,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogManifest {
    pub protocol_major: u32,
    pub libraries: Vec<CatalogLibraryRecord>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMergeResult {
    pub created: usize,
    pub updated: usize,
    pub deleted: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeLibrary {
    pub(crate) id: String,
    pub(crate) sync_library_id: String,
    pub(crate) name: String,
    pub(crate) database_url: String,
    pub(crate) media_directory: String,
    pub(crate) browser_storage_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCatalog {
    pub(crate) libraries: Vec<KnowledgeLibrary>,
    active_library_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyKnowledgeLibrary {
    id: String,
    #[serde(default)]
    sync_library_id: Option<String>,
    name: String,
    database_url: String,
    media_directory: String,
    browser_storage_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLibraryCatalog {
    libraries: Vec<LegacyKnowledgeLibrary>,
    active_library_id: String,
}

pub(crate) fn open_catalog(app_data_dir: &Path) -> Result<Connection, String> {
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let connection = Connection::open(app_data_dir.join(CATALOG_DATABASE_FILENAME))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(CATALOG_SCHEMA)
        .map_err(|error| error.to_string())?;
    let version: i64 = connection
        .query_row(
            "SELECT MAX(version) FROM rollmap_catalog_migrations",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    if version > CATALOG_SCHEMA_VERSION {
        return Err(format!(
            "Library catalog schema {version} is newer than this app supports"
        ));
    }
    Ok(connection)
}

fn validate_id(id: &str) -> Result<(), String> {
    let is_safe = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
    if !is_safe {
        return Err("Library ID contains unsupported characters".into());
    }
    Ok(())
}

fn validate_media_directory(media_directory: &str) -> Result<(), String> {
    if media_directory == "media" {
        return Ok(());
    }
    let suffix = media_directory
        .strip_prefix("media/")
        .ok_or_else(|| "Library media directory must be inside media".to_string())?;
    let is_safe = !suffix.is_empty()
        && !suffix.contains(['/', '\\'])
        && suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
    if !is_safe {
        return Err("Library media directory contains unsupported characters".into());
    }
    Ok(())
}

fn validate_library(library: &KnowledgeLibrary) -> Result<(), String> {
    validate_id(&library.id)?;
    Uuid::parse_str(&library.sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    if library.name.trim().is_empty() || library.name.chars().count() > 120 {
        return Err("Library name must contain between 1 and 120 characters".into());
    }
    crate::storage::database_filename(&library.database_url)?;
    validate_media_directory(&library.media_directory)?;
    if !library.browser_storage_key.starts_with("rollmap.graph") {
        return Err("Library browser storage key is invalid".into());
    }
    Ok(())
}

fn set_meta(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO catalog_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn get_meta(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn local_device_id(app_data_dir: &Path) -> Result<String, String> {
    let connection = open_catalog(app_data_dir)?;
    ensure_local_device_id(&connection)
}

fn ensure_local_device_id(connection: &Connection) -> Result<String, String> {
    let generated_id = Uuid::new_v4().to_string();
    connection
        .execute(
            "INSERT OR IGNORE INTO catalog_meta (key, value) VALUES ('local_device_id', ?1)",
            [&generated_id],
        )
        .map_err(|error| error.to_string())?;
    let device_id = get_meta(connection, "local_device_id")?
        .ok_or_else(|| "Could not create the local device identity".to_string())?;
    Uuid::parse_str(&device_id)
        .map_err(|_| "The local device identity is not a UUID".to_string())?;
    Ok(device_id)
}

fn now_ms() -> Result<i64, String> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(value).map_err(|_| "System time is outside the catalog range".into())
}

fn next_catalog_revision(
    connection: &Connection,
    writer_device_id: &str,
) -> Result<CatalogRevision, String> {
    let previous_physical = get_meta(connection, "catalog_hlc_physical_ms")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let previous_logical = get_meta(connection, "catalog_hlc_logical_counter")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let wall_time = now_ms()?;
    let physical_ms = wall_time.max(previous_physical);
    let logical_counter = if physical_ms == previous_physical {
        previous_logical + 1
    } else {
        0
    };
    set_meta(
        connection,
        "catalog_hlc_physical_ms",
        &physical_ms.to_string(),
    )?;
    set_meta(
        connection,
        "catalog_hlc_logical_counter",
        &logical_counter.to_string(),
    )?;
    Ok(CatalogRevision {
        physical_ms,
        logical_counter,
        writer_device_id: writer_device_id.to_string(),
    })
}

fn record_library_version(
    connection: &Connection,
    sync_library_id: &str,
    name: &str,
    deleted: bool,
    writer_device_id: &str,
) -> Result<(), String> {
    let revision = next_catalog_revision(connection, writer_device_id)?;
    connection
        .execute(
            "INSERT INTO library_versions (
                sync_library_id, name, is_deleted, hlc_physical_ms,
                hlc_logical_counter, writer_device_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(sync_library_id) DO UPDATE SET
                name = excluded.name,
                is_deleted = excluded.is_deleted,
                hlc_physical_ms = excluded.hlc_physical_ms,
                hlc_logical_counter = excluded.hlc_logical_counter,
                writer_device_id = excluded.writer_device_id",
            (
                sync_library_id,
                name,
                deleted,
                revision.physical_ms,
                revision.logical_counter,
                revision.writer_device_id,
            ),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn observe_catalog_revision(
    connection: &Connection,
    revision: &CatalogRevision,
) -> Result<(), String> {
    let local_physical = get_meta(connection, "catalog_hlc_physical_ms")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let local_logical = get_meta(connection, "catalog_hlc_logical_counter")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let (physical_ms, logical_counter) = if revision.physical_ms > local_physical {
        (revision.physical_ms, revision.logical_counter)
    } else if revision.physical_ms == local_physical {
        (local_physical, local_logical.max(revision.logical_counter))
    } else {
        (local_physical, local_logical)
    };
    set_meta(
        connection,
        "catalog_hlc_physical_ms",
        &physical_ms.to_string(),
    )?;
    set_meta(
        connection,
        "catalog_hlc_logical_counter",
        &logical_counter.to_string(),
    )
}

fn ensure_library_versions(connection: &Connection, writer_device_id: &str) -> Result<(), String> {
    let missing = {
        let mut statement = connection
            .prepare(
                "SELECT libraries.sync_library_id, libraries.name,
                        libraries.deleted_at IS NOT NULL
                 FROM libraries
                 LEFT JOIN library_versions
                   ON library_versions.sync_library_id = libraries.sync_library_id
                 WHERE library_versions.sync_library_id IS NULL
                 ORDER BY libraries.created_at, libraries.id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    for (sync_library_id, name, deleted) in missing {
        record_library_version(
            connection,
            &sync_library_id,
            &name,
            deleted,
            writer_device_id,
        )?;
    }
    Ok(())
}

pub fn required_sync_peer_ids(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<Vec<String>, String> {
    crate::storage::database_filename(database_url)?;
    let connection = open_catalog(app_data_dir)?;
    let library_exists: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM libraries WHERE database_url = ?1 AND deleted_at IS NULL
             )",
            [database_url],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !library_exists {
        return Err("Knowledge database is not registered in the library catalog".into());
    }
    let mut statement = connection
        .prepare(
            "SELECT peers.device_id
             FROM trusted_peers AS peers
             JOIN trusted_peer_libraries AS access
               ON access.peer_device_id = peers.device_id
             JOIN libraries
               ON libraries.sync_library_id = access.sync_library_id
             WHERE libraries.database_url = ?1
               AND libraries.deleted_at IS NULL
               AND peers.revoked_at IS NULL
               AND access.revoked_at IS NULL
             ORDER BY peers.device_id",
        )
        .map_err(|error| error.to_string())?;
    let peer_ids = statement
        .query_map([database_url], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for peer_id in &peer_ids {
        Uuid::parse_str(peer_id)
            .map_err(|_| "A trusted peer identity is not a UUID".to_string())?;
    }
    Ok(peer_ids)
}

pub(crate) fn library_media_directory(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<String, String> {
    crate::storage::database_filename(database_url)?;
    let connection = open_catalog(app_data_dir)?;
    connection
        .query_row(
            "SELECT media_directory FROM libraries
             WHERE database_url = ?1 AND deleted_at IS NULL",
            [database_url],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Knowledge database is not registered in the library catalog".to_string())
}

pub(crate) fn library_database_url(
    app_data_dir: &Path,
    sync_library_id: &str,
) -> Result<String, String> {
    Uuid::parse_str(sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    let connection = open_catalog(app_data_dir)?;
    let database_url = connection
        .query_row(
            "SELECT database_url FROM libraries
             WHERE sync_library_id = ?1 AND deleted_at IS NULL",
            [sync_library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Knowledge library is not registered on this device".to_string())?;
    crate::storage::database_filename(&database_url)?;
    Ok(database_url)
}

pub fn authorized_library_database_url(
    app_data_dir: &Path,
    peer_device_id: &str,
    sync_library_id: &str,
) -> Result<String, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    Uuid::parse_str(sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    let connection = open_catalog(app_data_dir)?;
    connection
        .query_row(
            "SELECT libraries.database_url
             FROM libraries
             JOIN trusted_peer_libraries AS access
               ON access.sync_library_id = libraries.sync_library_id
             JOIN trusted_peers AS peers
               ON peers.device_id = access.peer_device_id
             WHERE peers.device_id = ?1
               AND libraries.sync_library_id = ?2
               AND libraries.deleted_at IS NULL
               AND peers.revoked_at IS NULL
               AND access.revoked_at IS NULL",
            (peer_device_id, sync_library_id),
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Peer is not authorized for this knowledge library".to_string())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthorizedSyncLibrary {
    pub sync_library_id: String,
    pub database_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MediaSourcePeer {
    pub device_id: String,
    pub base_url: String,
    pub database_url: String,
}

pub(crate) fn media_source_peers(
    app_data_dir: &Path,
    sync_library_id: &str,
) -> Result<Vec<MediaSourcePeer>, String> {
    Uuid::parse_str(sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    let connection = open_catalog(app_data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT peers.device_id, endpoints.base_url, libraries.database_url
                         FROM libraries
                         JOIN trusted_peer_libraries AS access
                             ON access.sync_library_id = libraries.sync_library_id
                         JOIN trusted_peers AS peers
                             ON peers.device_id = access.peer_device_id
                         JOIN trusted_peer_endpoints AS endpoints
                             ON endpoints.peer_device_id = peers.device_id
                         WHERE libraries.sync_library_id = ?1
                             AND libraries.deleted_at IS NULL
                             AND peers.revoked_at IS NULL
                             AND access.revoked_at IS NULL
                         ORDER BY endpoints.updated_at DESC, peers.device_id",
        )
        .map_err(|error| error.to_string())?;
    let peers = statement
        .query_map([sync_library_id], |row| {
            Ok(MediaSourcePeer {
                device_id: row.get(0)?,
                base_url: row.get(1)?,
                database_url: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(peers)
}

pub(crate) fn authorized_sync_libraries(
    app_data_dir: &Path,
    peer_device_id: &str,
) -> Result<Vec<AuthorizedSyncLibrary>, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let connection = open_catalog(app_data_dir)?;
    let mut statement = connection
        .prepare(
            "SELECT libraries.sync_library_id, libraries.database_url
             FROM libraries
             JOIN trusted_peer_libraries AS access
               ON access.sync_library_id = libraries.sync_library_id
             JOIN trusted_peers AS peers
               ON peers.device_id = access.peer_device_id
             WHERE peers.device_id = ?1
               AND libraries.deleted_at IS NULL
               AND peers.revoked_at IS NULL
               AND access.revoked_at IS NULL
             ORDER BY libraries.sync_library_id",
        )
        .map_err(|error| error.to_string())?;
    let libraries = statement
        .query_map([peer_device_id], |row| {
            Ok(AuthorizedSyncLibrary {
                sync_library_id: row.get(0)?,
                database_url: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(libraries)
}

fn validate_catalog_record(record: &CatalogLibraryRecord) -> Result<(), String> {
    Uuid::parse_str(&record.sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    Uuid::parse_str(&record.revision.writer_device_id)
        .map_err(|_| "Catalog revision writer must be a UUID".to_string())?;
    if record.name.trim().is_empty() || record.name.chars().count() > 120 {
        return Err("Library name must contain between 1 and 120 characters".into());
    }
    if record.revision.physical_ms < 0 || record.revision.logical_counter < 0 {
        return Err("Catalog revision cannot be negative".into());
    }
    Ok(())
}

pub(crate) fn export_catalog_manifest(
    app_data_dir: &Path,
    peer_device_id: &str,
) -> Result<CatalogManifest, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let connection = open_catalog(app_data_dir)?;
    let device_id = ensure_local_device_id(&connection)?;
    ensure_library_versions(&connection, &device_id)?;
    let mut statement = connection
        .prepare(
            "SELECT versions.sync_library_id, versions.name, versions.is_deleted,
                    versions.hlc_physical_ms, versions.hlc_logical_counter,
                    versions.writer_device_id
             FROM library_versions AS versions
             JOIN trusted_peer_libraries AS access
               ON access.sync_library_id = versions.sync_library_id
             JOIN trusted_peers AS peers
               ON peers.device_id = access.peer_device_id
             WHERE peers.device_id = ?1
               AND peers.revoked_at IS NULL
               AND access.revoked_at IS NULL
             ORDER BY versions.sync_library_id",
        )
        .map_err(|error| error.to_string())?;
    let libraries = statement
        .query_map([peer_device_id], |row| {
            Ok(CatalogLibraryRecord {
                sync_library_id: row.get(0)?,
                name: row.get(1)?,
                deleted: row.get(2)?,
                revision: CatalogRevision {
                    physical_ms: row.get(3)?,
                    logical_counter: row.get(4)?,
                    writer_device_id: row.get(5)?,
                },
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(CatalogManifest {
        protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
        libraries,
    })
}

pub(crate) fn merge_catalog_manifest(
    app_data_dir: &Path,
    peer_device_id: &str,
    manifest: CatalogManifest,
) -> Result<CatalogMergeResult, String> {
    if manifest.protocol_major != crate::sync_protocol::PROTOCOL_MAJOR {
        return Err("Catalog manifest protocol version is not supported".into());
    }
    if manifest.libraries.len() > 1_000 {
        return Err("Catalog manifest contains too many libraries".into());
    }
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    for record in &manifest.libraries {
        validate_catalog_record(record)?;
    }
    let mut connection = open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let peer_is_trusted: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM trusted_peers
                WHERE device_id = ?1 AND revoked_at IS NULL
             )",
            [peer_device_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !peer_is_trusted {
        return Err("Catalog manifest sender is not a trusted peer".into());
    }
    let local_device_id = ensure_local_device_id(&transaction)?;
    ensure_library_versions(&transaction, &local_device_id)?;
    let mut result = CatalogMergeResult::default();
    for record in manifest.libraries {
        let existing: Option<(String, CatalogRevision)> = transaction
            .query_row(
                "SELECT libraries.id, versions.hlc_physical_ms,
                        versions.hlc_logical_counter, versions.writer_device_id
                 FROM libraries
                 JOIN library_versions AS versions
                   ON versions.sync_library_id = libraries.sync_library_id
                 WHERE libraries.sync_library_id = ?1",
                [&record.sync_library_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        CatalogRevision {
                            physical_ms: row.get(1)?,
                            logical_counter: row.get(2)?,
                            writer_device_id: row.get(3)?,
                        },
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing.is_none() {
            let library = KnowledgeLibrary {
                id: record.sync_library_id.clone(),
                sync_library_id: record.sync_library_id.clone(),
                name: record.name.trim().to_string(),
                database_url: format!("sqlite:rollmap-library-{}.db", record.sync_library_id),
                media_directory: format!("media/{}", record.sync_library_id),
                browser_storage_key: format!("rollmap.graph.library.{}", record.sync_library_id),
            };
            insert_library(&transaction, &library)?;
            if record.deleted {
                transaction
                    .execute(
                        "UPDATE libraries SET deleted_at = CURRENT_TIMESTAMP
                         WHERE sync_library_id = ?1",
                        [&record.sync_library_id],
                    )
                    .map_err(|error| error.to_string())?;
            }
            result.created += usize::from(!record.deleted);
            result.deleted += usize::from(record.deleted);
        }
        transaction
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 VALUES (?1, ?2)
                 ON CONFLICT(peer_device_id, sync_library_id) DO UPDATE SET revoked_at = NULL",
                (peer_device_id, &record.sync_library_id),
            )
            .map_err(|error| error.to_string())?;
        let should_apply = existing
            .as_ref()
            .is_none_or(|(_, revision)| record.revision > *revision);
        let is_default = existing.as_ref().is_some_and(|(id, _)| id == "default");
        if should_apply && !(is_default && record.deleted) {
            transaction
                .execute(
                    "UPDATE libraries SET
                        name = ?2,
                        deleted_at = CASE WHEN ?3 THEN CURRENT_TIMESTAMP ELSE NULL END,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE sync_library_id = ?1",
                    (&record.sync_library_id, record.name.trim(), record.deleted),
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO library_versions (
                        sync_library_id, name, is_deleted, hlc_physical_ms,
                        hlc_logical_counter, writer_device_id
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(sync_library_id) DO UPDATE SET
                        name = excluded.name,
                        is_deleted = excluded.is_deleted,
                        hlc_physical_ms = excluded.hlc_physical_ms,
                        hlc_logical_counter = excluded.hlc_logical_counter,
                        writer_device_id = excluded.writer_device_id",
                    (
                        &record.sync_library_id,
                        record.name.trim(),
                        record.deleted,
                        record.revision.physical_ms,
                        record.revision.logical_counter,
                        &record.revision.writer_device_id,
                    ),
                )
                .map_err(|error| error.to_string())?;
            if existing.is_some() {
                if record.deleted {
                    result.deleted += 1;
                } else {
                    result.updated += 1;
                }
            }
        }
        observe_catalog_revision(&transaction, &record.revision)?;
    }
    let active_library_id =
        get_meta(&transaction, "active_library_id")?.unwrap_or_else(|| "default".into());
    let active_is_live: bool = transaction
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM libraries WHERE id = ?1 AND deleted_at IS NULL
             )",
            [&active_library_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !active_is_live {
        set_meta(&transaction, "active_library_id", "default")?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn save_trusted_peer_endpoint(
    app_data_dir: &Path,
    peer_device_id: &str,
    base_url: &str,
) -> Result<(), String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    if base_url.is_empty() || base_url.len() > 2048 {
        return Err("LAN server URL has an invalid length".into());
    }
    let connection = open_catalog(app_data_dir)?;
    let peer_exists: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM trusted_peers
                WHERE device_id = ?1 AND revoked_at IS NULL
             )",
            [peer_device_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !peer_exists {
        return Err("Trusted peer does not exist or is revoked".into());
    }
    connection
        .execute(
            "INSERT INTO trusted_peer_endpoints (peer_device_id, base_url)
             VALUES (?1, ?2)
             ON CONFLICT(peer_device_id) DO UPDATE SET
                base_url = excluded.base_url,
                updated_at = CURRENT_TIMESTAMP",
            (peer_device_id, base_url),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_library(connection: &Connection, library: &KnowledgeLibrary) -> Result<(), String> {
    validate_library(library)?;
    connection
        .execute(
            "INSERT INTO libraries (
                id, sync_library_id, name, database_url, media_directory, browser_storage_key
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO NOTHING",
            (
                &library.id,
                &library.sync_library_id,
                library.name.trim(),
                &library.database_url,
                &library.media_directory,
                &library.browser_storage_key,
            ),
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_default_library(connection: &Connection) -> Result<(), String> {
    let library = KnowledgeLibrary {
        id: "default".into(),
        sync_library_id: Uuid::new_v4().to_string(),
        name: "Default database".into(),
        database_url: "sqlite:rollmap.db".into(),
        media_directory: "media".into(),
        browser_storage_key: "rollmap.graph.v1".into(),
    };
    insert_library(connection, &library)
}

fn import_legacy_catalog(
    connection: &Connection,
    legacy_catalog: Option<LegacyLibraryCatalog>,
) -> Result<(), String> {
    if get_meta(connection, "legacy_catalog_imported")?.is_some() {
        return Ok(());
    }

    ensure_default_library(connection)?;
    let mut active_library_id = "default".to_string();
    if let Some(legacy_catalog) = legacy_catalog {
        for legacy_library in legacy_catalog
            .libraries
            .into_iter()
            .filter(|library| library.id != "default")
        {
            let sync_library_id = legacy_library
                .sync_library_id
                .filter(|identity| Uuid::parse_str(identity).is_ok())
                .or_else(|| {
                    Uuid::parse_str(&legacy_library.id)
                        .ok()
                        .map(|identity| identity.to_string())
                })
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            insert_library(
                connection,
                &KnowledgeLibrary {
                    id: legacy_library.id,
                    sync_library_id,
                    name: legacy_library.name,
                    database_url: legacy_library.database_url,
                    media_directory: legacy_library.media_directory,
                    browser_storage_key: legacy_library.browser_storage_key,
                },
            )?;
        }
        let active_exists: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM libraries WHERE id = ?1 AND deleted_at IS NULL
                 )",
                [&legacy_catalog.active_library_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if active_exists {
            active_library_id = legacy_catalog.active_library_id;
        }
    }
    set_meta(connection, "active_library_id", &active_library_id)?;
    set_meta(connection, "legacy_catalog_imported", "1")
}

fn read_catalog(connection: &Connection) -> Result<LibraryCatalog, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, sync_library_id, name, database_url, media_directory,
                    browser_storage_key
             FROM libraries
             WHERE deleted_at IS NULL
             ORDER BY CASE id WHEN 'default' THEN 0 ELSE 1 END, created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let libraries = statement
        .query_map([], |row| {
            Ok(KnowledgeLibrary {
                id: row.get(0)?,
                sync_library_id: row.get(1)?,
                name: row.get(2)?,
                database_url: row.get(3)?,
                media_directory: row.get(4)?,
                browser_storage_key: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let requested_active =
        get_meta(connection, "active_library_id")?.unwrap_or_else(|| "default".to_string());
    let active_library_id = libraries
        .iter()
        .find(|library| library.id == requested_active)
        .map(|library| library.id.clone())
        .unwrap_or_else(|| "default".to_string());
    Ok(LibraryCatalog {
        libraries,
        active_library_id,
    })
}

pub fn load_library_catalog(
    app_data_dir: &Path,
    legacy_catalog: Option<LegacyLibraryCatalog>,
) -> Result<LibraryCatalog, String> {
    let mut connection = open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    import_legacy_catalog(&transaction, legacy_catalog)?;
    let device_id = ensure_local_device_id(&transaction)?;
    ensure_library_versions(&transaction, &device_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    read_catalog(&connection)
}

pub fn save_library_catalog(app_data_dir: &Path, catalog: LibraryCatalog) -> Result<(), String> {
    if !catalog
        .libraries
        .iter()
        .any(|library| library.id == "default")
    {
        return Err("The permanent default library cannot be removed".into());
    }
    if !catalog
        .libraries
        .iter()
        .any(|library| library.id == catalog.active_library_id)
    {
        return Err("Active library is not present in the catalog".into());
    }

    let device_id = local_device_id(app_data_dir)?;
    let mut connection = open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    ensure_default_library(&transaction)?;
    ensure_library_versions(&transaction, &device_id)?;
    for library in &catalog.libraries {
        validate_library(library)?;
        let existing: Option<(String, String, bool)> = transaction
            .query_row(
                "SELECT sync_library_id, name, deleted_at IS NOT NULL
                 FROM libraries WHERE id = ?1",
                [&library.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing
            .as_ref()
            .is_some_and(|(identity, _, _)| identity != &library.sync_library_id)
        {
            return Err("Library sync identity cannot be changed".into());
        }
        insert_library(&transaction, library)?;
        transaction
            .execute(
                "UPDATE libraries SET
                    name = ?2,
                    database_url = ?3,
                    media_directory = ?4,
                    browser_storage_key = ?5,
                    deleted_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                (
                    &library.id,
                    library.name.trim(),
                    &library.database_url,
                    &library.media_directory,
                    &library.browser_storage_key,
                ),
            )
            .map_err(|error| error.to_string())?;
        if existing
            .as_ref()
            .is_none_or(|(_, name, deleted)| name != library.name.trim() || *deleted)
        {
            record_library_version(
                &transaction,
                &library.sync_library_id,
                library.name.trim(),
                false,
                &device_id,
            )?;
        }
        transaction
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 SELECT device_id, ?1 FROM trusted_peers WHERE revoked_at IS NULL
                 ON CONFLICT(peer_device_id, sync_library_id) DO UPDATE SET revoked_at = NULL",
                [&library.sync_library_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let retained_ids = catalog
        .libraries
        .iter()
        .map(|library| library.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let removed = {
        let mut statement = transaction
            .prepare(
                "SELECT id, sync_library_id, name FROM libraries
                 WHERE id <> 'default' AND deleted_at IS NULL",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    for (id, sync_library_id, name) in removed {
        if retained_ids.contains(id.as_str()) {
            continue;
        }
        transaction
            .execute(
                "UPDATE libraries SET deleted_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                [&id],
            )
            .map_err(|error| error.to_string())?;
        record_library_version(&transaction, &sync_library_id, &name, true, &device_id)?;
    }
    set_meta(
        &transaction,
        "active_library_id",
        &catalog.active_library_id,
    )?;
    set_meta(&transaction, "legacy_catalog_imported", "1")?;
    transaction.commit().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rollmap-catalog-{name}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn custom_legacy_library(id: &str) -> LegacyKnowledgeLibrary {
        LegacyKnowledgeLibrary {
            id: id.into(),
            sync_library_id: None,
            name: "Competition game".into(),
            database_url: format!("sqlite:rollmap-library-{id}.db"),
            media_directory: format!("media/{id}"),
            browser_storage_key: format!("rollmap.graph.library.{id}"),
        }
    }

    #[test]
    fn creates_a_stable_native_identity_for_the_default_library() {
        let directory = TestDirectory::new("default");
        let first = load_library_catalog(&directory.0, None).expect("load catalog");
        let first_identity = &first.libraries[0].sync_library_id;
        assert_eq!(first.libraries[0].id, "default");
        assert!(Uuid::parse_str(first_identity).is_ok());
        assert_ne!(first_identity, "default");

        let second = load_library_catalog(&directory.0, None).expect("reload catalog");
        assert_eq!(second.libraries[0].sync_library_id, *first_identity);

        let first_device_id = local_device_id(&directory.0).expect("create device identity");
        let second_device_id = local_device_id(&directory.0).expect("reload device identity");
        assert!(Uuid::parse_str(&first_device_id).is_ok());
        assert_eq!(second_device_id, first_device_id);
    }

    #[test]
    fn imports_the_legacy_catalog_only_once_and_restores_its_active_library() {
        let directory = TestDirectory::new("legacy");
        let custom_id = "550e8400-e29b-41d4-a716-446655440000";
        let first = load_library_catalog(
            &directory.0,
            Some(LegacyLibraryCatalog {
                libraries: vec![custom_legacy_library(custom_id)],
                active_library_id: custom_id.into(),
            }),
        )
        .expect("import catalog");
        assert_eq!(first.active_library_id, custom_id);
        assert_eq!(first.libraries[1].sync_library_id, custom_id);

        let second = load_library_catalog(
            &directory.0,
            Some(LegacyLibraryCatalog {
                libraries: Vec::new(),
                active_library_id: "default".into(),
            }),
        )
        .expect("reload catalog");
        assert_eq!(second, first);
    }

    #[test]
    fn saves_new_libraries_but_never_rewrites_their_sync_identity() {
        let directory = TestDirectory::new("save");
        let mut catalog = load_library_catalog(&directory.0, None).expect("load catalog");
        let custom_id = "550e8400-e29b-41d4-a716-446655440000";
        catalog.libraries.push(KnowledgeLibrary {
            id: custom_id.into(),
            sync_library_id: custom_id.into(),
            name: "Competition game".into(),
            database_url: format!("sqlite:rollmap-library-{custom_id}.db"),
            media_directory: format!("media/{custom_id}"),
            browser_storage_key: format!("rollmap.graph.library.{custom_id}"),
        });
        catalog.active_library_id = custom_id.into();
        save_library_catalog(&directory.0, catalog.clone()).expect("save catalog");
        assert_eq!(
            load_library_catalog(&directory.0, None).expect("reload catalog"),
            catalog
        );

        catalog.libraries[1].sync_library_id = Uuid::new_v4().to_string();
        let error =
            save_library_catalog(&directory.0, catalog).expect_err("reject identity replacement");
        assert!(error.contains("cannot be changed"));
    }

    #[test]
    fn records_library_rename_and_delete_revisions() {
        let directory = TestDirectory::new("library-versions");
        let mut catalog = load_library_catalog(&directory.0, None).expect("load catalog");
        let custom_id = "550e8400-e29b-41d4-a716-446655440000";
        catalog.libraries.push(KnowledgeLibrary {
            id: custom_id.into(),
            sync_library_id: custom_id.into(),
            name: "Competition game".into(),
            database_url: format!("sqlite:rollmap-library-{custom_id}.db"),
            media_directory: format!("media/{custom_id}"),
            browser_storage_key: format!("rollmap.graph.library.{custom_id}"),
        });
        save_library_catalog(&directory.0, catalog.clone()).expect("save custom library");
        let connection = open_catalog(&directory.0).expect("open catalog");
        let first_revision: (i64, i64) = connection
            .query_row(
                "SELECT hlc_physical_ms, hlc_logical_counter
                 FROM library_versions WHERE sync_library_id = ?1",
                [custom_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read initial revision");
        drop(connection);

        catalog.libraries[1].name = "Renamed game".into();
        save_library_catalog(&directory.0, catalog.clone()).expect("rename library");
        let connection = open_catalog(&directory.0).expect("open renamed catalog");
        let renamed: (String, bool, i64, i64) = connection
            .query_row(
                "SELECT name, is_deleted, hlc_physical_ms, hlc_logical_counter
                 FROM library_versions WHERE sync_library_id = ?1",
                [custom_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read renamed revision");
        assert_eq!(renamed.0, "Renamed game");
        assert!(!renamed.1);
        assert!((renamed.2, renamed.3) > first_revision);
        drop(connection);

        catalog.libraries.pop();
        catalog.active_library_id = "default".into();
        save_library_catalog(&directory.0, catalog).expect("delete library");
        let connection = open_catalog(&directory.0).expect("open deleted catalog");
        let deleted: (bool, i64, i64) = connection
            .query_row(
                "SELECT is_deleted, hlc_physical_ms, hlc_logical_counter
                 FROM library_versions WHERE sync_library_id = ?1",
                [custom_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read delete revision");
        assert!(deleted.0);
        assert!((deleted.1, deleted.2) > (renamed.2, renamed.3));
    }

    #[test]
    fn merges_catalog_manifests_across_device_local_paths() {
        let source = TestDirectory::new("manifest-source");
        let target = TestDirectory::new("manifest-target");
        let mut source_catalog = load_library_catalog(&source.0, None).expect("load source");
        load_library_catalog(&target.0, None).expect("load target");
        let source_device_id = local_device_id(&source.0).expect("source device ID");
        let target_device_id = local_device_id(&target.0).expect("target device ID");
        let source_default_sync_id = source_catalog.libraries[0].sync_library_id.clone();
        let source_connection = open_catalog(&source.0).expect("open source catalog");
        source_connection
            .execute(
                "INSERT INTO trusted_peers (
                    device_id, display_name, identity_public_key
                 ) VALUES (?1, 'Target', ?2)",
                (&target_device_id, vec![7_u8; 32]),
            )
            .expect("trust target");
        source_connection
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 VALUES (?1, ?2)",
                (&target_device_id, &source_default_sync_id),
            )
            .expect("authorize source default");
        drop(source_connection);
        let target_connection = open_catalog(&target.0).expect("open target catalog");
        target_connection
            .execute(
                "INSERT INTO trusted_peers (
                    device_id, display_name, identity_public_key
                 ) VALUES (?1, 'Source', ?2)",
                (&source_device_id, vec![8_u8; 32]),
            )
            .expect("trust source");
        drop(target_connection);

        let custom_id = "550e8400-e29b-41d4-a716-446655440000";
        source_catalog.libraries.push(KnowledgeLibrary {
            id: custom_id.into(),
            sync_library_id: custom_id.into(),
            name: "Competition".into(),
            database_url: format!("sqlite:rollmap-library-{custom_id}.db"),
            media_directory: format!("media/{custom_id}"),
            browser_storage_key: format!("rollmap.graph.library.{custom_id}"),
        });
        save_library_catalog(&source.0, source_catalog.clone()).expect("save source library");
        let created = merge_catalog_manifest(
            &target.0,
            &source_device_id,
            export_catalog_manifest(&source.0, &target_device_id).expect("export create"),
        )
        .expect("merge create");
        assert_eq!(created.created, 2);
        let target_catalog = load_library_catalog(&target.0, None).expect("read target replica");
        let replica = target_catalog
            .libraries
            .iter()
            .find(|library| library.sync_library_id == custom_id)
            .expect("find target replica");
        assert_eq!(replica.name, "Competition");
        assert_eq!(
            replica.database_url,
            format!("sqlite:rollmap-library-{custom_id}.db")
        );

        source_catalog.libraries[1].name = "Renamed competition".into();
        save_library_catalog(&source.0, source_catalog.clone()).expect("rename source library");
        let renamed = merge_catalog_manifest(
            &target.0,
            &source_device_id,
            export_catalog_manifest(&source.0, &target_device_id).expect("export rename"),
        )
        .expect("merge rename");
        assert_eq!(renamed.updated, 1);
        assert_eq!(
            load_library_catalog(&target.0, None)
                .expect("read renamed target")
                .libraries
                .iter()
                .find(|library| library.sync_library_id == custom_id)
                .expect("find renamed replica")
                .name,
            "Renamed competition"
        );

        source_catalog.libraries.pop();
        save_library_catalog(&source.0, source_catalog).expect("delete source library");
        let deleted = merge_catalog_manifest(
            &target.0,
            &source_device_id,
            export_catalog_manifest(&source.0, &target_device_id).expect("export delete"),
        )
        .expect("merge delete");
        assert_eq!(deleted.deleted, 1);
        assert!(load_library_catalog(&target.0, None)
            .expect("read deleted target")
            .libraries
            .iter()
            .all(|library| library.sync_library_id != custom_id));
    }

    #[test]
    fn scopes_required_sync_peers_to_active_library_authorizations() {
        let directory = TestDirectory::new("trusted-peers");
        let catalog = load_library_catalog(&directory.0, None).expect("load catalog");
        let sync_library_id = &catalog.libraries[0].sync_library_id;
        let active_peer = "550e8400-e29b-41d4-a716-446655440000";
        let revoked_peer = "7b2cd5dc-c12c-43f6-86f6-4e3b51b0dc49";
        let connection = open_catalog(&directory.0).expect("open catalog");
        connection
            .execute(
                "INSERT INTO trusted_peers (
                    device_id, display_name, identity_public_key
                 ) VALUES (?1, 'Active peer', ?2)",
                (active_peer, vec![1_u8; 32]),
            )
            .expect("insert active peer");
        connection
            .execute(
                "INSERT INTO trusted_peers (
                    device_id, display_name, identity_public_key, revoked_at
                 ) VALUES (?1, 'Revoked peer', ?2, CURRENT_TIMESTAMP)",
                (revoked_peer, vec![2_u8; 32]),
            )
            .expect("insert revoked peer");
        for peer_id in [active_peer, revoked_peer] {
            connection
                .execute(
                    "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                     VALUES (?1, ?2)",
                    (peer_id, sync_library_id),
                )
                .expect("authorize peer library");
        }
        drop(connection);

        assert_eq!(
            required_sync_peer_ids(&directory.0, "sqlite:rollmap.db").expect("read required peers"),
            vec![active_peer.to_string()]
        );
        assert_eq!(
            authorized_library_database_url(&directory.0, active_peer, sync_library_id)
                .expect("resolve authorized library"),
            "sqlite:rollmap.db"
        );
        let unauthorized_peer = "84ef9237-307d-45c7-b5c2-121d5e24bc3f";
        assert!(
            authorized_library_database_url(&directory.0, unauthorized_peer, sync_library_id,)
                .expect_err("reject unauthorized peer")
                .contains("not authorized")
        );
    }

    #[test]
    fn upgrades_v1_without_rewriting_the_library_identity() {
        let directory = TestDirectory::new("upgrade-v1");
        let database_path = directory.0.join(CATALOG_DATABASE_FILENAME);
        let original_identity = "550e8400-e29b-41d4-a716-446655440000";
        let connection = Connection::open(database_path).expect("open v1 catalog");
        connection
            .execute_batch(&format!(
                "CREATE TABLE rollmap_catalog_migrations (
                    version INTEGER PRIMARY KEY NOT NULL,
                    description TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE catalog_meta (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE libraries (
                    id TEXT PRIMARY KEY NOT NULL,
                    sync_library_id TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    database_url TEXT NOT NULL UNIQUE,
                    media_directory TEXT NOT NULL UNIQUE,
                    browser_storage_key TEXT NOT NULL UNIQUE,
                    deleted_at TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO rollmap_catalog_migrations (version, description)
                VALUES (1, 'initial_catalog');
                INSERT INTO libraries (
                    id, sync_library_id, name, database_url,
                    media_directory, browser_storage_key
                ) VALUES (
                    'default', '{original_identity}', 'Original library',
                    'sqlite:rollmap.db', 'media', 'rollmap.graph.v1'
                );"
            ))
            .expect("create v1 catalog");
        drop(connection);

        let catalog = load_library_catalog(&directory.0, None).expect("upgrade v1 catalog");
        assert_eq!(catalog.libraries[0].sync_library_id, original_identity);
        assert_eq!(catalog.libraries[0].name, "Original library");
        let upgraded = open_catalog(&directory.0).expect("open upgraded catalog");
        let version: i64 = upgraded
            .query_row(
                "SELECT MAX(version) FROM rollmap_catalog_migrations",
                [],
                |row| row.get(0),
            )
            .expect("read upgraded version");
        assert_eq!(version, 5);
        let trust_table_exists: bool = upgraded
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'trusted_peers'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read trusted peer table");
        assert!(trust_table_exists);
        let pairing_table_exists: bool = upgraded
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'pairing_sessions'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read pairing session table");
        assert!(pairing_table_exists);
        let endpoint_table_exists: bool = upgraded
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'trusted_peer_endpoints'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read trusted peer endpoint table");
        assert!(endpoint_table_exists);
    }
}
