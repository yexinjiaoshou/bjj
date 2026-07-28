use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const BASELINE_COMPLETE_KEY: &str = "baseline_complete";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    id: String,
    name: String,
    aliases: Vec<String>,
    description: String,
    category: String,
    role: String,
    tags: Vec<String>,
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Technique {
    id: String,
    source_position_id: String,
    target_position_id: Option<String>,
    name: String,
    description: String,
    gi_mode: String,
    difficulty: String,
    tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub(crate) id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) value: String,
    #[serde(default)]
    pub(crate) blob_hash: Option<String>,
    #[serde(default)]
    pub(crate) mime_type: Option<String>,
    #[serde(default)]
    pub(crate) file_extension: Option<String>,
    #[serde(default)]
    pub(crate) byte_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionCoordinates {
    id: String,
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coordinates {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraph {
    positions: Vec<Position>,
    techniques: Vec<Technique>,
    attachments: Vec<Attachment>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionEntity {
    id: String,
    name: String,
    aliases: Vec<String>,
    description: String,
    category: String,
    role: String,
    tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionLayout {
    position_id: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum GraphMutation {
    #[serde(rename = "importGraph")]
    ImportGraph { graph: KnowledgeGraph },
    #[serde(rename = "savePosition")]
    SavePosition { position: Position },
    #[serde(rename = "movePosition")]
    MovePosition {
        #[serde(rename = "positionId")]
        position_id: String,
        coordinates: Coordinates,
    },
    #[serde(rename = "saveLayout")]
    SaveLayout { positions: Vec<PositionCoordinates> },
    #[serde(rename = "deletePosition")]
    DeletePosition {
        #[serde(rename = "positionId")]
        position_id: String,
    },
    #[serde(rename = "saveTechnique")]
    SaveTechnique { technique: Technique },
    #[serde(rename = "deleteTechnique")]
    DeleteTechnique {
        #[serde(rename = "techniqueId")]
        technique_id: String,
    },
    #[serde(rename = "saveAttachment")]
    SaveAttachment { attachment: Attachment },
    #[serde(rename = "deleteAttachment")]
    DeleteAttachment {
        #[serde(rename = "attachmentId")]
        attachment_id: String,
    },
    #[serde(rename = "restoreHistorySnapshot")]
    RestoreHistorySnapshot { graph: KnowledgeGraph },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridTimestamp {
    pub physical_ms: i64,
    pub logical_counter: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncEntityType {
    Position,
    PositionLayout,
    Technique,
    Attachment,
}

impl SyncEntityType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Position => "position",
            Self::PositionLayout => "position_layout",
            Self::Technique => "technique",
            Self::Attachment => "attachment",
        }
    }

    fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "position" => Ok(Self::Position),
            "position_layout" => Ok(Self::PositionLayout),
            "technique" => Ok(Self::Technique),
            "attachment" => Ok(Self::Attachment),
            _ => Err(format!("Unknown sync entity type: {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncOperation {
    Upsert,
    Delete,
}

impl SyncOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::Delete => "delete",
        }
    }

    fn from_database(value: &str) -> Result<Self, String> {
        match value {
            "upsert" => Ok(Self::Upsert),
            "delete" => Ok(Self::Delete),
            _ => Err(format!("Unknown sync operation: {value}")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChange {
    pub sequence: i64,
    pub change_id: String,
    pub entity_type: SyncEntityType,
    pub entity_id: String,
    pub operation: SyncOperation,
    pub generation: i64,
    pub hlc: HybridTimestamp,
    pub origin_device_id: String,
    pub payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBatch {
    pub(crate) changes: Vec<SyncChange>,
    pub(crate) next_cursor: i64,
    pub(crate) has_more: bool,
    pub(crate) journal_floor: i64,
    pub(crate) current_cursor: i64,
    pub(crate) requires_snapshot: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub(crate) base_cursor: i64,
    pub(crate) changes: Vec<SyncChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMergeResult {
    pub(crate) received: usize,
    pub(crate) accepted: usize,
    pub(crate) applied: usize,
    pub(crate) ignored: usize,
    pub(crate) conflicts: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCompactionResult {
    previous_floor: i64,
    compacted_through: i64,
    deleted_changes: usize,
    required_peer_count: usize,
    blocked_by_peer_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PendingSyncDelivery {
    pub pending_changes: usize,
    pub requires_snapshot: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerCursorKind {
    Pulled,
    Acknowledged,
}

impl PeerCursorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pulled => "pulled",
            Self::Acknowledged => "acknowledged",
        }
    }
}

fn open_database(app_data_dir: &Path, database_url: &str) -> Result<Connection, String> {
    let filename = crate::storage::database_filename(database_url)?;
    let connection =
        Connection::open(app_data_dir.join(filename)).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn current_time_ms() -> Result<i64, String> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(milliseconds).map_err(|_| "System time is outside SQLite's range".into())
}

fn next_timestamp(transaction: &Transaction<'_>) -> Result<HybridTimestamp, String> {
    let (previous_physical, previous_logical): (i64, i64) = transaction
        .query_row(
            "SELECT physical_ms, logical_counter FROM sync_hlc_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let now = current_time_ms()?;
    let timestamp = if now > previous_physical {
        HybridTimestamp {
            physical_ms: now,
            logical_counter: 0,
        }
    } else {
        HybridTimestamp {
            physical_ms: previous_physical,
            logical_counter: previous_logical
                .checked_add(1)
                .ok_or_else(|| "Hybrid logical clock overflowed".to_string())?,
        }
    };
    transaction
        .execute(
            "UPDATE sync_hlc_state
             SET physical_ms = ?1, logical_counter = ?2
             WHERE singleton = 1",
            params![timestamp.physical_ms, timestamp.logical_counter],
        )
        .map_err(|error| error.to_string())?;
    Ok(timestamp)
}

fn observe_timestamp(transaction: &Transaction<'_>, remote: HybridTimestamp) -> Result<(), String> {
    let (local_physical, local_logical): (i64, i64) = transaction
        .query_row(
            "SELECT physical_ms, logical_counter FROM sync_hlc_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let now = current_time_ms()?;
    let physical_ms = now.max(local_physical).max(remote.physical_ms);
    let logical_counter = if physical_ms == local_physical && physical_ms == remote.physical_ms {
        local_logical.max(remote.logical_counter).checked_add(1)
    } else if physical_ms == local_physical {
        local_logical.checked_add(1)
    } else if physical_ms == remote.physical_ms {
        remote.logical_counter.checked_add(1)
    } else {
        Some(0)
    }
    .ok_or_else(|| "Hybrid logical clock overflowed".to_string())?;
    transaction
        .execute(
            "UPDATE sync_hlc_state
             SET physical_ms = ?1, logical_counter = ?2
             WHERE singleton = 1",
            params![physical_ms, logical_counter],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn record_upsert(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    payload_json: &str,
    device_id: &str,
) -> Result<(), String> {
    record_upsert_with_mode(
        transaction,
        entity_type,
        entity_id,
        payload_json,
        device_id,
        false,
    )
}

fn record_upsert_with_mode(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    payload_json: &str,
    device_id: &str,
    allow_restore: bool,
) -> Result<(), String> {
    let current = transaction
        .query_row(
            "SELECT generation, is_deleted FROM sync_entity_versions
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type, entity_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if current.is_some_and(|(_, is_deleted)| is_deleted) && !allow_restore {
        return Err("A deleted sync entity identity cannot be reused".into());
    }
    let generation = match current {
        Some((generation, true)) => generation
            .checked_add(1)
            .ok_or_else(|| "Sync entity generation overflowed".to_string())?,
        Some((generation, false)) => generation,
        None => 0,
    };
    let timestamp = next_timestamp(transaction)?;
    let change_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO sync_journal (
                change_id, entity_type, entity_id, operation, generation,
                hlc_physical_ms, hlc_logical_counter, origin_device_id, payload_json
             ) VALUES (?1, ?2, ?3, 'upsert', ?4, ?5, ?6, ?7, ?8)",
            params![
                change_id,
                entity_type,
                entity_id,
                generation,
                timestamp.physical_ms,
                timestamp.logical_counter,
                device_id,
                payload_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sync_entity_versions (
                entity_type, entity_id, generation, hlc_physical_ms,
                hlc_logical_counter, origin_device_id, is_deleted, payload_json,
                winning_change_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                generation = excluded.generation,
                hlc_physical_ms = excluded.hlc_physical_ms,
                hlc_logical_counter = excluded.hlc_logical_counter,
                origin_device_id = excluded.origin_device_id,
                is_deleted = 0,
                     payload_json = excluded.payload_json,
                     winning_change_id = excluded.winning_change_id",
            params![
                entity_type,
                entity_id,
                generation,
                timestamp.physical_ms,
                timestamp.logical_counter,
                device_id,
                payload_json,
                change_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM sync_tombstones WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type, entity_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn record_delete(
    transaction: &Transaction<'_>,
    entity_type: &str,
    entity_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let generation = transaction
        .query_row(
            "SELECT generation FROM sync_entity_versions
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type, entity_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    let timestamp = next_timestamp(transaction)?;
    let change_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO sync_journal (
                     change_id, entity_type, entity_id, operation, generation,
                     hlc_physical_ms, hlc_logical_counter, origin_device_id, payload_json
                 ) VALUES (?1, ?2, ?3, 'delete', ?4, ?5, ?6, ?7, NULL)",
            params![
                change_id,
                entity_type,
                entity_id,
                generation,
                timestamp.physical_ms,
                timestamp.logical_counter,
                device_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sync_entity_versions (
                     entity_type, entity_id, generation, hlc_physical_ms,
                     hlc_logical_counter, origin_device_id, is_deleted, payload_json,
                     winning_change_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL, ?7)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                     generation = excluded.generation,
                hlc_physical_ms = excluded.hlc_physical_ms,
                hlc_logical_counter = excluded.hlc_logical_counter,
                origin_device_id = excluded.origin_device_id,
                is_deleted = 1,
                payload_json = NULL,
                winning_change_id = excluded.winning_change_id",
            params![
                entity_type,
                entity_id,
                generation,
                timestamp.physical_ms,
                timestamp.logical_counter,
                device_id,
                change_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sync_tombstones (
                     entity_type, entity_id, generation, hlc_physical_ms,
                     hlc_logical_counter, origin_device_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                     generation = excluded.generation,
                hlc_physical_ms = excluded.hlc_physical_ms,
                hlc_logical_counter = excluded.hlc_logical_counter,
                origin_device_id = excluded.origin_device_id,
                deleted_at = CURRENT_TIMESTAMP",
            params![
                entity_type,
                entity_id,
                generation,
                timestamp.physical_ms,
                timestamp.logical_counter,
                device_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn string_array(value: String) -> Vec<String> {
    serde_json::from_str::<Vec<Value>>(&value)
        .map(|items| {
            items
                .into_iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn position_entity_payload(position: &Position) -> Result<String, String> {
    serde_json::to_string(&PositionEntity {
        id: position.id.clone(),
        name: position.name.clone(),
        aliases: position.aliases.clone(),
        description: position.description.clone(),
        category: position.category.clone(),
        role: position.role.clone(),
        tags: position.tags.clone(),
    })
    .map_err(|error| error.to_string())
}

fn position_layout_payload(id: &str, x: f64, y: f64) -> Result<String, String> {
    serde_json::to_string(&PositionLayout {
        position_id: id.to_string(),
        x,
        y,
    })
    .map_err(|error| error.to_string())
}

fn validate_coordinates(x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Position coordinates must be finite".into());
    }
    Ok(())
}

fn upsert_position(
    transaction: &Transaction<'_>,
    position: &Position,
    device_id: &str,
) -> Result<(), String> {
    upsert_position_with_mode(transaction, position, device_id, false)
}

fn restore_history_position(
    transaction: &Transaction<'_>,
    current: Option<&Position>,
    position: &Position,
    device_id: &str,
) -> Result<(), String> {
    write_position(transaction, position)?;
    let content_changed = match current {
        Some(current) => position_entity_payload(current)? != position_entity_payload(position)?,
        None => true,
    };
    if content_changed {
        record_upsert_with_mode(
            transaction,
            "position",
            &position.id,
            &position_entity_payload(position)?,
            device_id,
            true,
        )?;
    }
    if current.is_none_or(|current| current.x != position.x || current.y != position.y) {
        record_upsert_with_mode(
            transaction,
            "position_layout",
            &position.id,
            &position_layout_payload(&position.id, position.x, position.y)?,
            device_id,
            true,
        )?;
    }
    Ok(())
}

fn write_position(transaction: &Transaction<'_>, position: &Position) -> Result<(), String> {
    validate_coordinates(position.x, position.y)?;
    let aliases_json =
        serde_json::to_string(&position.aliases).map_err(|error| error.to_string())?;
    let tags_json = serde_json::to_string(&position.tags).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO positions (
                id, name, aliases_json, description, category, role, tags_json, x, y
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                aliases_json = excluded.aliases_json,
                description = excluded.description,
                category = excluded.category,
                role = excluded.role,
                tags_json = excluded.tags_json,
                x = excluded.x,
                y = excluded.y,
                updated_at = CURRENT_TIMESTAMP",
            params![
                position.id,
                position.name,
                aliases_json,
                position.description,
                position.category,
                position.role,
                tags_json,
                position.x,
                position.y,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_position_with_mode(
    transaction: &Transaction<'_>,
    position: &Position,
    device_id: &str,
    allow_restore: bool,
) -> Result<(), String> {
    write_position(transaction, position)?;
    record_upsert_with_mode(
        transaction,
        "position",
        &position.id,
        &position_entity_payload(position)?,
        device_id,
        allow_restore,
    )?;
    record_upsert_with_mode(
        transaction,
        "position_layout",
        &position.id,
        &position_layout_payload(&position.id, position.x, position.y)?,
        device_id,
        allow_restore,
    )
}

fn move_position(
    transaction: &Transaction<'_>,
    position_id: &str,
    coordinates: &Coordinates,
    device_id: &str,
) -> Result<(), String> {
    validate_coordinates(coordinates.x, coordinates.y)?;
    let changed = transaction
        .execute(
            "UPDATE positions SET x = ?1, y = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?3",
            params![coordinates.x, coordinates.y, position_id],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("Position does not exist".into());
    }
    record_upsert(
        transaction,
        "position_layout",
        position_id,
        &position_layout_payload(position_id, coordinates.x, coordinates.y)?,
        device_id,
    )
}

fn upsert_technique(
    transaction: &Transaction<'_>,
    technique: &Technique,
    device_id: &str,
) -> Result<(), String> {
    upsert_technique_with_mode(transaction, technique, device_id, false)
}

fn restore_history_technique(
    transaction: &Transaction<'_>,
    technique: &Technique,
    device_id: &str,
) -> Result<(), String> {
    upsert_technique_with_mode(transaction, technique, device_id, true)
}

fn upsert_technique_with_mode(
    transaction: &Transaction<'_>,
    technique: &Technique,
    device_id: &str,
    allow_restore: bool,
) -> Result<(), String> {
    let tags_json = serde_json::to_string(&technique.tags).map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO techniques (
                id, source_position_id, target_position_id, name, description,
                gi_mode, difficulty, tags_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                source_position_id = excluded.source_position_id,
                target_position_id = excluded.target_position_id,
                name = excluded.name,
                description = excluded.description,
                gi_mode = excluded.gi_mode,
                difficulty = excluded.difficulty,
                tags_json = excluded.tags_json,
                updated_at = CURRENT_TIMESTAMP",
            params![
                technique.id,
                technique.source_position_id,
                technique.target_position_id,
                technique.name,
                technique.description,
                technique.gi_mode,
                technique.difficulty,
                tags_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    record_upsert_with_mode(
        transaction,
        "technique",
        &technique.id,
        &serde_json::to_string(technique).map_err(|error| error.to_string())?,
        device_id,
        allow_restore,
    )
}

fn upsert_attachment(
    transaction: &Transaction<'_>,
    attachment: &Attachment,
    device_id: &str,
) -> Result<(), String> {
    upsert_attachment_with_mode(transaction, attachment, device_id, false)
}

fn restore_history_attachment(
    transaction: &Transaction<'_>,
    attachment: &Attachment,
    device_id: &str,
) -> Result<(), String> {
    upsert_attachment_with_mode(transaction, attachment, device_id, true)
}

fn upsert_attachment_with_mode(
    transaction: &Transaction<'_>,
    attachment: &Attachment,
    device_id: &str,
    allow_restore: bool,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO attachments (
                id, owner_type, owner_id, kind, title, value,
                blob_hash, mime_type, file_extension, byte_size
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                owner_type = excluded.owner_type,
                owner_id = excluded.owner_id,
                kind = excluded.kind,
                title = excluded.title,
                value = excluded.value,
                blob_hash = excluded.blob_hash,
                mime_type = excluded.mime_type,
                file_extension = excluded.file_extension,
                byte_size = excluded.byte_size",
            params![
                attachment.id,
                attachment.owner_type,
                attachment.owner_id,
                attachment.kind,
                attachment.title,
                attachment.value,
                attachment.blob_hash,
                attachment.mime_type,
                attachment.file_extension,
                attachment.byte_size,
            ],
        )
        .map_err(|error| error.to_string())?;
    record_upsert_with_mode(
        transaction,
        "attachment",
        &attachment.id,
        &attachment_sync_payload(attachment)?,
        device_id,
        allow_restore,
    )
}

fn attachment_sync_payload(attachment: &Attachment) -> Result<String, String> {
    let mut payload = attachment.clone();
    if matches!(payload.kind.as_str(), "image" | "video") {
        payload.value.clear();
    }
    serde_json::to_string(&payload).map_err(|error| error.to_string())
}

fn query_ids(
    transaction: &Transaction<'_>,
    sql: &str,
    parameters: &[&dyn rusqlite::ToSql],
) -> Result<Vec<String>, String> {
    let mut statement = transaction
        .prepare(sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(parameters, |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

fn delete_technique(
    transaction: &Transaction<'_>,
    technique_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let attachment_ids = query_ids(
        transaction,
        "SELECT id FROM attachments
         WHERE owner_type = 'technique' AND owner_id = ?1 ORDER BY id",
        &[&technique_id],
    )?;
    transaction
        .execute("DELETE FROM techniques WHERE id = ?1", [technique_id])
        .map_err(|error| error.to_string())?;
    for attachment_id in attachment_ids {
        record_delete(transaction, "attachment", &attachment_id, device_id)?;
    }
    record_delete(transaction, "technique", technique_id, device_id)
}

fn delete_position(
    transaction: &Transaction<'_>,
    position_id: &str,
    device_id: &str,
) -> Result<(), String> {
    let technique_ids = query_ids(
        transaction,
        "SELECT id FROM techniques
         WHERE source_position_id = ?1 OR target_position_id = ?1 ORDER BY id",
        &[&position_id],
    )?;
    let mut attachment_ids = query_ids(
        transaction,
        "SELECT id FROM attachments
         WHERE owner_type = 'position' AND owner_id = ?1 ORDER BY id",
        &[&position_id],
    )?
    .into_iter()
    .collect::<BTreeSet<_>>();
    for technique_id in &technique_ids {
        attachment_ids.extend(query_ids(
            transaction,
            "SELECT id FROM attachments
             WHERE owner_type = 'technique' AND owner_id = ?1 ORDER BY id",
            &[technique_id],
        )?);
    }
    transaction
        .execute("DELETE FROM positions WHERE id = ?1", [position_id])
        .map_err(|error| error.to_string())?;
    for attachment_id in attachment_ids {
        record_delete(transaction, "attachment", &attachment_id, device_id)?;
    }
    for technique_id in technique_ids {
        record_delete(transaction, "technique", &technique_id, device_id)?;
    }
    record_delete(transaction, "position_layout", position_id, device_id)?;
    record_delete(transaction, "position", position_id, device_id)
}

fn delete_attachment(
    transaction: &Transaction<'_>,
    attachment_id: &str,
    device_id: &str,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM attachments WHERE id = ?1", [attachment_id])
        .map_err(|error| error.to_string())?;
    record_delete(transaction, "attachment", attachment_id, device_id)
}

fn load_positions(transaction: &Transaction<'_>) -> Result<Vec<Position>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, name, aliases_json, description, category, role, tags_json, x, y
             FROM positions ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let positions = statement
        .query_map([], |row| {
            Ok(Position {
                id: row.get(0)?,
                name: row.get(1)?,
                aliases: string_array(row.get(2)?),
                description: row.get(3)?,
                category: row.get(4)?,
                role: row.get(5)?,
                tags: string_array(row.get(6)?),
                x: row.get(7)?,
                y: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(positions)
}

fn load_techniques(transaction: &Transaction<'_>) -> Result<Vec<Technique>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT id, source_position_id, target_position_id, name, description,
                    gi_mode, difficulty, tags_json
             FROM techniques ORDER BY created_at, id",
        )
        .map_err(|error| error.to_string())?;
    let techniques = statement
        .query_map([], |row| {
            Ok(Technique {
                id: row.get(0)?,
                source_position_id: row.get(1)?,
                target_position_id: row.get(2)?,
                name: row.get(3)?,
                description: row.get(4)?,
                gi_mode: row.get(5)?,
                difficulty: row.get(6)?,
                tags: string_array(row.get(7)?),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(techniques)
}

fn load_attachments(transaction: &Transaction<'_>) -> Result<Vec<Attachment>, String> {
    let mut statement = transaction
        .prepare(
            "SELECT attachments.id, owner_type, owner_id, kind, title,
                    CASE
                        WHEN attachments.blob_hash IS NOT NULL
                        THEN COALESCE(media_blobs.relative_path, '')
                        ELSE attachments.value
                    END,
                    attachments.blob_hash, attachments.mime_type,
                    attachments.file_extension, attachments.byte_size
             FROM attachments
             LEFT JOIN media_blobs ON media_blobs.blob_hash = attachments.blob_hash
             ORDER BY owner_type, owner_id, sort_order, attachments.created_at, attachments.id",
        )
        .map_err(|error| error.to_string())?;
    let attachments = statement
        .query_map([], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                owner_type: row.get(1)?,
                owner_id: row.get(2)?,
                kind: row.get(3)?,
                title: row.get(4)?,
                value: row.get(5)?,
                blob_hash: row.get(6)?,
                mime_type: row.get(7)?,
                file_extension: row.get(8)?,
                byte_size: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(attachments)
}

fn validate_history_snapshot(graph: &KnowledgeGraph) -> Result<(), String> {
    let position_ids = graph
        .positions
        .iter()
        .map(|position| position.id.as_str())
        .collect::<BTreeSet<_>>();
    if position_ids.len() != graph.positions.len() {
        return Err("History snapshot contains duplicate positions".into());
    }
    let technique_ids = graph
        .techniques
        .iter()
        .map(|technique| technique.id.as_str())
        .collect::<BTreeSet<_>>();
    if technique_ids.len() != graph.techniques.len() {
        return Err("History snapshot contains duplicate transitions".into());
    }
    let attachment_ids = graph
        .attachments
        .iter()
        .map(|attachment| attachment.id.as_str())
        .collect::<BTreeSet<_>>();
    if attachment_ids.len() != graph.attachments.len() {
        return Err("History snapshot contains duplicate attachments".into());
    }
    for technique in &graph.techniques {
        if !position_ids.contains(technique.source_position_id.as_str())
            || technique
                .target_position_id
                .as_deref()
                .is_some_and(|target| !position_ids.contains(target))
        {
            return Err("History snapshot transition references a missing position".into());
        }
    }
    for attachment in &graph.attachments {
        let owner_exists = match attachment.owner_type.as_str() {
            "position" => position_ids.contains(attachment.owner_id.as_str()),
            "technique" => technique_ids.contains(attachment.owner_id.as_str()),
            _ => return Err("History snapshot attachment owner type is invalid".into()),
        };
        if !owner_exists {
            return Err("History snapshot attachment references a missing owner".into());
        }
    }
    Ok(())
}

fn restore_history_snapshot(
    transaction: &Transaction<'_>,
    graph: &KnowledgeGraph,
    device_id: &str,
) -> Result<(), String> {
    validate_history_snapshot(graph)?;
    let current_positions = load_positions(transaction)?
        .into_iter()
        .map(|position| (position.id.clone(), position))
        .collect::<BTreeMap<_, _>>();
    let current_techniques = load_techniques(transaction)?
        .into_iter()
        .map(|technique| (technique.id.clone(), technique))
        .collect::<BTreeMap<_, _>>();
    let current_attachments = load_attachments(transaction)?
        .into_iter()
        .map(|attachment| (attachment.id.clone(), attachment))
        .collect::<BTreeMap<_, _>>();
    let target_positions = graph
        .positions
        .iter()
        .map(|position| (position.id.as_str(), position))
        .collect::<BTreeMap<_, _>>();
    let target_techniques = graph
        .techniques
        .iter()
        .map(|technique| (technique.id.as_str(), technique))
        .collect::<BTreeMap<_, _>>();
    let target_attachments = graph
        .attachments
        .iter()
        .map(|attachment| (attachment.id.as_str(), attachment))
        .collect::<BTreeMap<_, _>>();

    for attachment_id in current_attachments.keys() {
        if !target_attachments.contains_key(attachment_id.as_str()) {
            delete_attachment(transaction, attachment_id, device_id)?;
        }
    }
    for technique_id in current_techniques.keys() {
        if !target_techniques.contains_key(technique_id.as_str()) {
            delete_technique(transaction, technique_id, device_id)?;
        }
    }
    for position_id in current_positions.keys() {
        if !target_positions.contains_key(position_id.as_str()) {
            delete_position(transaction, position_id, device_id)?;
        }
    }
    for position in &graph.positions {
        if current_positions.get(&position.id) != Some(position) {
            restore_history_position(
                transaction,
                current_positions.get(&position.id),
                position,
                device_id,
            )?;
        }
    }
    for technique in &graph.techniques {
        if current_techniques.get(&technique.id) != Some(technique) {
            restore_history_technique(transaction, technique, device_id)?;
        }
    }
    for attachment in &graph.attachments {
        if current_attachments.get(&attachment.id) != Some(attachment) {
            restore_history_attachment(transaction, attachment, device_id)?;
        }
    }
    Ok(())
}

pub fn bootstrap_database(
    app_data_dir: &Path,
    database_url: &str,
    device_id: &str,
) -> Result<(), String> {
    Uuid::parse_str(device_id)
        .map_err(|_| "The local device identity is not a UUID".to_string())?;
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let is_complete = transaction
        .query_row(
            "SELECT value FROM sync_store_meta WHERE key = ?1",
            [BASELINE_COMPLETE_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if is_complete {
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }

    for position in load_positions(&transaction)? {
        record_upsert(
            &transaction,
            "position",
            &position.id,
            &position_entity_payload(&position)?,
            device_id,
        )?;
        record_upsert(
            &transaction,
            "position_layout",
            &position.id,
            &position_layout_payload(&position.id, position.x, position.y)?,
            device_id,
        )?;
    }
    for technique in load_techniques(&transaction)? {
        record_upsert(
            &transaction,
            "technique",
            &technique.id,
            &serde_json::to_string(&technique).map_err(|error| error.to_string())?,
            device_id,
        )?;
    }
    for attachment in load_attachments(&transaction)? {
        record_upsert(
            &transaction,
            "attachment",
            &attachment.id,
            &serde_json::to_string(&attachment).map_err(|error| error.to_string())?,
            device_id,
        )?;
    }
    transaction
        .execute(
            "INSERT INTO sync_store_meta (key, value) VALUES (?1, '1')",
            [BASELINE_COMPLETE_KEY],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn apply_graph_mutation(
    app_data_dir: &Path,
    database_url: &str,
    device_id: &str,
    mutation: GraphMutation,
) -> Result<(), String> {
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    match mutation {
        GraphMutation::ImportGraph { graph } => {
            for position in &graph.positions {
                upsert_position(&transaction, position, device_id)?;
            }
            for technique in &graph.techniques {
                upsert_technique(&transaction, technique, device_id)?;
            }
            for attachment in &graph.attachments {
                upsert_attachment(&transaction, attachment, device_id)?;
            }
        }
        GraphMutation::SavePosition { position } => {
            upsert_position(&transaction, &position, device_id)?;
        }
        GraphMutation::MovePosition {
            position_id,
            coordinates,
        } => move_position(&transaction, &position_id, &coordinates, device_id)?,
        GraphMutation::SaveLayout { positions } => {
            for position in positions {
                move_position(
                    &transaction,
                    &position.id,
                    &Coordinates {
                        x: position.x,
                        y: position.y,
                    },
                    device_id,
                )?;
            }
        }
        GraphMutation::DeletePosition { position_id } => {
            delete_position(&transaction, &position_id, device_id)?;
        }
        GraphMutation::SaveTechnique { technique } => {
            upsert_technique(&transaction, &technique, device_id)?;
        }
        GraphMutation::DeleteTechnique { technique_id } => {
            delete_technique(&transaction, &technique_id, device_id)?;
        }
        GraphMutation::SaveAttachment { attachment } => {
            upsert_attachment(&transaction, &attachment, device_id)?;
        }
        GraphMutation::DeleteAttachment { attachment_id } => {
            delete_attachment(&transaction, &attachment_id, device_id)?;
        }
        GraphMutation::RestoreHistorySnapshot { graph } => {
            restore_history_snapshot(&transaction, &graph, device_id)?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn read_sync_changes(
    app_data_dir: &Path,
    database_url: &str,
    after_sequence: i64,
    limit: u32,
) -> Result<SyncBatch, String> {
    if after_sequence < 0 {
        return Err("Sync cursor cannot be negative".into());
    }
    if !(1..=500).contains(&limit) {
        return Err("Sync page size must be between 1 and 500".into());
    }
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let journal_floor = transaction
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM sync_store_meta WHERE key = 'journal_floor'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let newest_sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM sync_journal",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let current_cursor = newest_sequence.max(journal_floor);
    if after_sequence < journal_floor {
        return Ok(SyncBatch {
            changes: Vec::new(),
            next_cursor: after_sequence,
            has_more: false,
            journal_floor,
            current_cursor,
            requires_snapshot: true,
        });
    }
    let row_limit = i64::from(limit) + 1;
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT sequence, change_id, entity_type, entity_id, operation,
                    generation, hlc_physical_ms, hlc_logical_counter,
                    origin_device_id, payload_json
                 FROM sync_journal
                 WHERE sequence > ?1
                 ORDER BY sequence
                 LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map(params![after_sequence, row_limit], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    let mut changes = rows
        .into_iter()
        .map(
            |(
                sequence,
                change_id,
                entity_type,
                entity_id,
                operation,
                generation,
                physical_ms,
                logical_counter,
                origin_device_id,
                payload_json,
            )| {
                Ok(SyncChange {
                    sequence,
                    change_id,
                    entity_type: SyncEntityType::from_database(&entity_type)?,
                    entity_id,
                    operation: SyncOperation::from_database(&operation)?,
                    generation,
                    hlc: HybridTimestamp {
                        physical_ms,
                        logical_counter,
                    },
                    origin_device_id,
                    payload: payload_json
                        .map(|payload| serde_json::from_str(&payload))
                        .transpose()
                        .map_err(|error| error.to_string())?,
                })
            },
        )
        .collect::<Result<Vec<_>, String>>()?;
    let has_more = changes.len() > limit as usize;
    changes.truncate(limit as usize);
    let next_cursor = changes
        .last()
        .map(|change| change.sequence)
        .unwrap_or(after_sequence);
    Ok(SyncBatch {
        changes,
        next_cursor,
        has_more,
        journal_floor,
        current_cursor,
        requires_snapshot: false,
    })
}

pub fn read_sync_snapshot(app_data_dir: &Path, database_url: &str) -> Result<SyncSnapshot, String> {
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let journal_floor = transaction
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM sync_store_meta WHERE key = 'journal_floor'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let newest_sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM sync_journal",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let base_cursor = newest_sequence.max(journal_floor);
    let rows = {
        let mut statement = transaction
            .prepare(
                "SELECT winning_change_id, entity_type, entity_id, is_deleted,
                    generation, hlc_physical_ms, hlc_logical_counter,
                    origin_device_id, payload_json
                 FROM sync_entity_versions
                 ORDER BY CASE
                    WHEN is_deleted = 0 AND entity_type = 'position' THEN 0
                    WHEN is_deleted = 0 AND entity_type = 'position_layout' THEN 1
                    WHEN is_deleted = 0 AND entity_type = 'technique' THEN 2
                    WHEN is_deleted = 0 AND entity_type = 'attachment' THEN 3
                    WHEN is_deleted = 1 AND entity_type = 'attachment' THEN 4
                    WHEN is_deleted = 1 AND entity_type = 'technique' THEN 5
                    WHEN is_deleted = 1 AND entity_type = 'position_layout' THEN 6
                    WHEN is_deleted = 1 AND entity_type = 'position' THEN 7
                    ELSE 8
                 END, entity_id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    let changes = rows
        .into_iter()
        .map(
            |(
                change_id,
                entity_type,
                entity_id,
                is_deleted,
                generation,
                physical_ms,
                logical_counter,
                origin_device_id,
                payload_json,
            )| {
                let operation = if is_deleted {
                    SyncOperation::Delete
                } else {
                    SyncOperation::Upsert
                };
                let payload = payload_json
                    .map(|payload| serde_json::from_str(&payload))
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let change = SyncChange {
                    sequence: base_cursor,
                    change_id,
                    entity_type: SyncEntityType::from_database(&entity_type)?,
                    entity_id,
                    operation,
                    generation,
                    hlc: HybridTimestamp {
                        physical_ms,
                        logical_counter,
                    },
                    origin_device_id,
                    payload,
                };
                validate_sync_change(&change)?;
                Ok(change)
            },
        )
        .collect::<Result<Vec<_>, String>>()?;
    Ok(SyncSnapshot {
        base_cursor,
        changes,
    })
}

pub fn update_peer_cursor(
    app_data_dir: &Path,
    database_url: &str,
    peer_device_id: &str,
    cursor_kind: PeerCursorKind,
    sequence: i64,
) -> Result<i64, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    if sequence < 0 {
        return Err("Sync cursor cannot be negative".into());
    }
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    if matches!(cursor_kind, PeerCursorKind::Acknowledged) {
        let journal_floor = transaction
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM sync_store_meta WHERE key = 'journal_floor'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let newest_sequence = transaction
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM sync_journal",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        if sequence > newest_sequence.max(journal_floor) {
            return Err("Acknowledged sync cursor cannot exceed current journal cursor".into());
        }
    }
    transaction
        .execute(
            "INSERT INTO sync_peer_cursors (peer_device_id, cursor_kind, sequence)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(peer_device_id, cursor_kind) DO UPDATE SET
                sequence = MAX(sync_peer_cursors.sequence, excluded.sequence),
                updated_at = CURRENT_TIMESTAMP",
            params![peer_device_id, cursor_kind.as_str(), sequence],
        )
        .map_err(|error| error.to_string())?;
    let stored_sequence = transaction
        .query_row(
            "SELECT sequence FROM sync_peer_cursors
             WHERE peer_device_id = ?1 AND cursor_kind = ?2",
            params![peer_device_id, cursor_kind.as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(stored_sequence)
}

pub fn read_peer_cursor(
    app_data_dir: &Path,
    database_url: &str,
    peer_device_id: &str,
    cursor_kind: PeerCursorKind,
) -> Result<i64, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let connection = open_database(app_data_dir, database_url)?;
    connection
        .query_row(
            "SELECT sequence FROM sync_peer_cursors
             WHERE peer_device_id = ?1 AND cursor_kind = ?2",
            params![peer_device_id, cursor_kind.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map(|sequence| sequence.unwrap_or(0))
        .map_err(|error| error.to_string())
}

pub fn pending_sync_delivery(
    app_data_dir: &Path,
    database_url: &str,
    peer_device_ids: &[String],
) -> Result<PendingSyncDelivery, String> {
    if peer_device_ids.is_empty() {
        return Ok(PendingSyncDelivery::default());
    }
    let connection = open_database(app_data_dir, database_url)?;
    let journal_floor = connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM sync_store_meta WHERE key = 'journal_floor'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let mut minimum_acknowledged = i64::MAX;
    for peer_device_id in peer_device_ids {
        Uuid::parse_str(peer_device_id)
            .map_err(|_| "Peer device identity must be a UUID".to_string())?;
        let acknowledged = connection
            .query_row(
                "SELECT sequence FROM sync_peer_cursors
                 WHERE peer_device_id = ?1 AND cursor_kind = 'acknowledged'",
                [peer_device_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(0);
        minimum_acknowledged = minimum_acknowledged.min(acknowledged);
    }
    if minimum_acknowledged < journal_floor {
        return Ok(PendingSyncDelivery {
            pending_changes: 0,
            requires_snapshot: true,
        });
    }
    let pending_changes = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_journal WHERE sequence > ?1",
            [minimum_acknowledged],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(PendingSyncDelivery {
        pending_changes: usize::try_from(pending_changes)
            .map_err(|_| "Pending sync count is outside the supported range")?,
        requires_snapshot: false,
    })
}

pub fn compact_sync_journal(
    app_data_dir: &Path,
    database_url: &str,
    required_peer_ids: &[String],
) -> Result<SyncCompactionResult, String> {
    let mut unique_peer_ids = BTreeSet::new();
    for peer_id in required_peer_ids {
        Uuid::parse_str(peer_id).map_err(|_| "Peer device identity must be a UUID".to_string())?;
        if !unique_peer_ids.insert(peer_id.as_str()) {
            return Err("Required sync peers must be unique".into());
        }
    }
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let previous_floor = transaction
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM sync_store_meta WHERE key = 'journal_floor'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let current_cursor = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM sync_journal",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?
        .max(previous_floor);
    let mut acknowledgements = Vec::with_capacity(required_peer_ids.len());
    let mut blocked_by_peer_ids = Vec::new();
    for peer_id in required_peer_ids {
        let acknowledgement = transaction
            .query_row(
                "SELECT sequence FROM sync_peer_cursors
                 WHERE peer_device_id = ?1 AND cursor_kind = 'acknowledged'",
                [peer_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(sequence) = acknowledgement {
            acknowledgements.push(sequence);
        } else {
            blocked_by_peer_ids.push(peer_id.clone());
        }
    }
    let safe_cursor = if blocked_by_peer_ids.is_empty() {
        acknowledgements
            .into_iter()
            .min()
            .unwrap_or(current_cursor)
            .min(current_cursor)
            .max(previous_floor)
    } else {
        previous_floor
    };
    let deleted_changes = if safe_cursor > previous_floor {
        let deleted = transaction
            .execute(
                "DELETE FROM sync_journal WHERE sequence <= ?1",
                [safe_cursor],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE sync_store_meta SET value = ?1 WHERE key = 'journal_floor'",
                [safe_cursor.to_string()],
            )
            .map_err(|error| error.to_string())?;
        deleted
    } else {
        0
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(SyncCompactionResult {
        previous_floor,
        compacted_through: safe_cursor,
        deleted_changes,
        required_peer_count: required_peer_ids.len(),
        blocked_by_peer_ids,
    })
}

fn validate_sync_change(change: &SyncChange) -> Result<Option<String>, String> {
    if change.sequence <= 0 {
        return Err("Remote sync sequence must be positive".into());
    }
    Uuid::parse_str(&change.change_id)
        .map_err(|_| "Sync change identity must be a UUID".to_string())?;
    Uuid::parse_str(&change.origin_device_id)
        .map_err(|_| "Sync change origin must be a UUID".to_string())?;
    if change.entity_id.is_empty() || change.entity_id.chars().count() > 200 {
        return Err("Sync entity identity must contain between 1 and 200 characters".into());
    }
    if change.hlc.physical_ms < 0 || change.hlc.logical_counter < 0 {
        return Err("Sync HLC values cannot be negative".into());
    }
    if change.generation < 0 {
        return Err("Sync generation cannot be negative".into());
    }
    match change.operation {
        SyncOperation::Delete => {
            if change.payload.is_some() {
                return Err("A sync deletion cannot contain a payload".into());
            }
            Ok(None)
        }
        SyncOperation::Upsert => {
            let payload = change
                .payload
                .clone()
                .ok_or_else(|| "A sync upsert must contain a payload".to_string())?;
            let payload_id = match change.entity_type {
                SyncEntityType::Position => {
                    serde_json::from_value::<PositionEntity>(payload.clone())
                        .map_err(|error| error.to_string())?
                        .id
                }
                SyncEntityType::PositionLayout => {
                    let layout = serde_json::from_value::<PositionLayout>(payload.clone())
                        .map_err(|error| error.to_string())?;
                    validate_coordinates(layout.x, layout.y)?;
                    layout.position_id
                }
                SyncEntityType::Technique => {
                    serde_json::from_value::<Technique>(payload.clone())
                        .map_err(|error| error.to_string())?
                        .id
                }
                SyncEntityType::Attachment => {
                    serde_json::from_value::<Attachment>(payload.clone())
                        .map_err(|error| error.to_string())?
                        .id
                }
            };
            if payload_id != change.entity_id {
                return Err("Sync payload identity does not match its record".into());
            }
            serde_json::to_string(&payload)
                .map(Some)
                .map_err(|error| error.to_string())
        }
    }
}

fn snapshot_order(change: &SyncChange) -> u8 {
    match (change.operation, change.entity_type) {
        (SyncOperation::Upsert, SyncEntityType::Position) => 0,
        (SyncOperation::Upsert, SyncEntityType::PositionLayout) => 1,
        (SyncOperation::Upsert, SyncEntityType::Technique) => 2,
        (SyncOperation::Upsert, SyncEntityType::Attachment) => 3,
        (SyncOperation::Delete, SyncEntityType::Attachment) => 4,
        (SyncOperation::Delete, SyncEntityType::Technique) => 5,
        (SyncOperation::Delete, SyncEntityType::PositionLayout) => 6,
        (SyncOperation::Delete, SyncEntityType::Position) => 7,
    }
}

fn validate_sync_snapshot(snapshot: &SyncSnapshot) -> Result<Vec<Option<String>>, String> {
    if snapshot.base_cursor < 0 {
        return Err("Snapshot base cursor cannot be negative".into());
    }
    let mut change_ids = BTreeSet::new();
    let mut entities = BTreeSet::new();
    let mut previous_order = None;
    let mut payloads = Vec::with_capacity(snapshot.changes.len());
    for change in &snapshot.changes {
        if change.sequence != snapshot.base_cursor {
            return Err("Snapshot record cursor does not match its base cursor".into());
        }
        if !change_ids.insert(change.change_id.as_str()) {
            return Err("Snapshot contains a duplicate change identity".into());
        }
        if !entities.insert((change.entity_type, change.entity_id.as_str())) {
            return Err("Snapshot contains multiple winners for one entity".into());
        }
        let order = (snapshot_order(change), change.entity_id.as_str());
        if previous_order.is_some_and(|previous| previous > order) {
            return Err("Snapshot records are not in dependency order".into());
        }
        previous_order = Some(order);
        payloads.push(validate_sync_change(change)?);
    }
    Ok(payloads)
}

fn incoming_change_wins(
    transaction: &Transaction<'_>,
    change: &SyncChange,
) -> Result<bool, String> {
    let current = transaction
        .query_row(
            "SELECT generation, hlc_physical_ms, hlc_logical_counter,
                    origin_device_id, is_deleted
             FROM sync_entity_versions
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![change.entity_type.as_str(), change.entity_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(current.is_none_or(
        |(generation, physical_ms, logical_counter, origin_device_id, is_deleted)| {
            (
                change.generation,
                change.operation == SyncOperation::Delete,
                change.hlc.physical_ms,
                change.hlc.logical_counter,
                change.origin_device_id.as_str(),
            ) > (
                generation,
                is_deleted,
                physical_ms,
                logical_counter,
                origin_device_id.as_str(),
            )
        },
    ))
}

#[derive(Clone)]
struct StoredVersion {
    generation: i64,
    hlc: HybridTimestamp,
    origin_device_id: String,
    is_deleted: bool,
}

fn stored_version(
    transaction: &Transaction<'_>,
    entity_type: SyncEntityType,
    entity_id: &str,
) -> Result<Option<StoredVersion>, String> {
    transaction
        .query_row(
            "SELECT generation, hlc_physical_ms, hlc_logical_counter,
                    origin_device_id, is_deleted
             FROM sync_entity_versions
             WHERE entity_type = ?1 AND entity_id = ?2",
            params![entity_type.as_str(), entity_id],
            |row| {
                Ok(StoredVersion {
                    generation: row.get(0)?,
                    hlc: HybridTimestamp {
                        physical_ms: row.get(1)?,
                        logical_counter: row.get(2)?,
                    },
                    origin_device_id: row.get(3)?,
                    is_deleted: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

struct ConflictBlocker {
    reason: &'static str,
    entity_type: SyncEntityType,
    entity_id: String,
    version: StoredVersion,
}

fn deleted_blocker(
    transaction: &Transaction<'_>,
    entity_type: SyncEntityType,
    entity_id: &str,
    reason: &'static str,
) -> Result<Option<ConflictBlocker>, String> {
    Ok(stored_version(transaction, entity_type, entity_id)?
        .filter(|version| version.is_deleted)
        .map(|version| ConflictBlocker {
            reason,
            entity_type,
            entity_id: entity_id.to_string(),
            version,
        }))
}

fn blocking_tombstone(
    transaction: &Transaction<'_>,
    change: &SyncChange,
) -> Result<Option<ConflictBlocker>, String> {
    if change.operation == SyncOperation::Delete {
        return Ok(None);
    }
    if let Some(blocker) = deleted_blocker(
        transaction,
        change.entity_type,
        &change.entity_id,
        "deleted_entity",
    )?
    .filter(|blocker| blocker.version.generation >= change.generation)
    {
        return Ok(Some(blocker));
    }
    let payload = change
        .payload
        .clone()
        .ok_or_else(|| "A sync upsert must contain a payload".to_string())?;
    let dependencies = match change.entity_type {
        SyncEntityType::Position => Vec::new(),
        SyncEntityType::PositionLayout => {
            vec![(SyncEntityType::Position, change.entity_id.clone())]
        }
        SyncEntityType::Technique => {
            let technique: Technique =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let mut dependencies = vec![(SyncEntityType::Position, technique.source_position_id)];
            if let Some(target_position_id) = technique.target_position_id {
                dependencies.push((SyncEntityType::Position, target_position_id));
            }
            dependencies
        }
        SyncEntityType::Attachment => {
            let attachment: Attachment =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let owner_type = match attachment.owner_type.as_str() {
                "position" => SyncEntityType::Position,
                "technique" => SyncEntityType::Technique,
                _ => return Err("Sync attachment owner type is invalid".into()),
            };
            vec![(owner_type, attachment.owner_id)]
        }
    };
    for (entity_type, entity_id) in dependencies {
        if let Some(blocker) =
            deleted_blocker(transaction, entity_type, &entity_id, "deleted_dependency")?
        {
            return Ok(Some(blocker));
        }
    }
    Ok(None)
}

fn record_conflict(
    transaction: &Transaction<'_>,
    change: &SyncChange,
    payload_json: Option<&str>,
    blocker: &ConflictBlocker,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO sync_conflicts (
                     change_id, entity_type, entity_id, operation, generation,
                     hlc_physical_ms, hlc_logical_counter, origin_device_id,
                     payload_json, reason,
                blocking_entity_type, blocking_entity_id, winning_hlc_physical_ms,
                     winning_hlc_logical_counter, winning_origin_device_id,
                     winning_generation
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                change.change_id,
                change.entity_type.as_str(),
                change.entity_id,
                change.operation.as_str(),
                change.generation,
                change.hlc.physical_ms,
                change.hlc.logical_counter,
                change.origin_device_id,
                payload_json,
                blocker.reason,
                blocker.entity_type.as_str(),
                blocker.entity_id,
                blocker.version.hlc.physical_ms,
                blocker.version.hlc.logical_counter,
                blocker.version.origin_device_id,
                blocker.version.generation,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn append_remote_change(
    transaction: &Transaction<'_>,
    change: &SyncChange,
    payload_json: Option<&str>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO sync_journal (
                     change_id, entity_type, entity_id, operation, generation,
                     hlc_physical_ms, hlc_logical_counter, origin_device_id, payload_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                change.change_id,
                change.entity_type.as_str(),
                change.entity_id,
                change.operation.as_str(),
                change.generation,
                change.hlc.physical_ms,
                change.hlc.logical_counter,
                change.origin_device_id,
                payload_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn position_coordinates(
    transaction: &Transaction<'_>,
    position_id: &str,
) -> Result<(f64, f64), String> {
    if let Some(coordinates) = transaction
        .query_row(
            "SELECT x, y FROM positions WHERE id = ?1",
            [position_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
    {
        return Ok(coordinates);
    }
    let layout_payload = transaction
        .query_row(
            "SELECT payload_json FROM sync_entity_versions
             WHERE entity_type = 'position_layout' AND entity_id = ?1
               AND is_deleted = 0",
            [position_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten();
    if let Some(payload) = layout_payload {
        let layout: PositionLayout =
            serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        validate_coordinates(layout.x, layout.y)?;
        return Ok((layout.x, layout.y));
    }
    Ok((0.0, 0.0))
}

fn materialize_remote_upsert(
    transaction: &Transaction<'_>,
    change: &SyncChange,
) -> Result<(), String> {
    let payload = change
        .payload
        .clone()
        .ok_or_else(|| "A sync upsert must contain a payload".to_string())?;
    match change.entity_type {
        SyncEntityType::Position => {
            let position: PositionEntity =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let (x, y) = position_coordinates(transaction, &position.id)?;
            transaction
                .execute(
                    "INSERT INTO positions (
                        id, name, aliases_json, description, category, role, tags_json, x, y
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        aliases_json = excluded.aliases_json,
                        description = excluded.description,
                        category = excluded.category,
                        role = excluded.role,
                        tags_json = excluded.tags_json,
                        updated_at = CURRENT_TIMESTAMP",
                    params![
                        position.id,
                        position.name,
                        serde_json::to_string(&position.aliases)
                            .map_err(|error| error.to_string())?,
                        position.description,
                        position.category,
                        position.role,
                        serde_json::to_string(&position.tags).map_err(|error| error.to_string())?,
                        x,
                        y,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        SyncEntityType::PositionLayout => {
            let layout: PositionLayout =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            validate_coordinates(layout.x, layout.y)?;
            transaction
                .execute(
                    "UPDATE positions
                     SET x = ?1, y = ?2, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?3",
                    params![layout.x, layout.y, layout.position_id],
                )
                .map_err(|error| error.to_string())?;
        }
        SyncEntityType::Technique => {
            let technique: Technique =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO techniques (
                        id, source_position_id, target_position_id, name, description,
                        gi_mode, difficulty, tags_json
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(id) DO UPDATE SET
                        source_position_id = excluded.source_position_id,
                        target_position_id = excluded.target_position_id,
                        name = excluded.name,
                        description = excluded.description,
                        gi_mode = excluded.gi_mode,
                        difficulty = excluded.difficulty,
                        tags_json = excluded.tags_json,
                        updated_at = CURRENT_TIMESTAMP",
                    params![
                        technique.id,
                        technique.source_position_id,
                        technique.target_position_id,
                        technique.name,
                        technique.description,
                        technique.gi_mode,
                        technique.difficulty,
                        serde_json::to_string(&technique.tags).map_err(|error| error.to_string())?,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        SyncEntityType::Attachment => {
            let attachment: Attachment =
                serde_json::from_value(payload).map_err(|error| error.to_string())?;
            let local_value = if let Some(blob_hash) = &attachment.blob_hash {
                transaction
                    .query_row(
                        "SELECT relative_path FROM media_blobs WHERE blob_hash = ?1",
                        [blob_hash],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .unwrap_or_default()
            } else {
                attachment.value.clone()
            };
            transaction
                .execute(
                    "INSERT INTO attachments (
                        id, owner_type, owner_id, kind, title, value,
                        blob_hash, mime_type, file_extension, byte_size
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(id) DO UPDATE SET
                        owner_type = excluded.owner_type,
                        owner_id = excluded.owner_id,
                        kind = excluded.kind,
                        title = excluded.title,
                        value = excluded.value,
                        blob_hash = excluded.blob_hash,
                        mime_type = excluded.mime_type,
                        file_extension = excluded.file_extension,
                        byte_size = excluded.byte_size",
                    params![
                        attachment.id,
                        attachment.owner_type,
                        attachment.owner_id,
                        attachment.kind,
                        attachment.title,
                        local_value,
                        attachment.blob_hash,
                        attachment.mime_type,
                        attachment.file_extension,
                        attachment.byte_size,
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn materialize_remote_delete(
    transaction: &Transaction<'_>,
    change: &SyncChange,
) -> Result<(), String> {
    let sql = match change.entity_type {
        SyncEntityType::Position => Some("DELETE FROM positions WHERE id = ?1"),
        SyncEntityType::PositionLayout => None,
        SyncEntityType::Technique => Some("DELETE FROM techniques WHERE id = ?1"),
        SyncEntityType::Attachment => Some("DELETE FROM attachments WHERE id = ?1"),
    };
    if let Some(sql) = sql {
        transaction
            .execute(sql, [&change.entity_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn store_remote_winner(
    transaction: &Transaction<'_>,
    change: &SyncChange,
    payload_json: Option<&str>,
) -> Result<(), String> {
    let is_deleted = i64::from(change.operation == SyncOperation::Delete);
    transaction
        .execute(
            "INSERT INTO sync_entity_versions (
                entity_type, entity_id, generation, hlc_physical_ms,
                hlc_logical_counter, origin_device_id, is_deleted, payload_json,
                winning_change_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                generation = excluded.generation,
                hlc_physical_ms = excluded.hlc_physical_ms,
                hlc_logical_counter = excluded.hlc_logical_counter,
                origin_device_id = excluded.origin_device_id,
                is_deleted = excluded.is_deleted,
                     payload_json = excluded.payload_json,
                     winning_change_id = excluded.winning_change_id",
            params![
                change.entity_type.as_str(),
                change.entity_id,
                change.generation,
                change.hlc.physical_ms,
                change.hlc.logical_counter,
                change.origin_device_id,
                is_deleted,
                payload_json,
                change.change_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if change.operation == SyncOperation::Delete {
        transaction
            .execute(
                "INSERT INTO sync_tombstones (
                          entity_type, entity_id, generation, hlc_physical_ms,
                          hlc_logical_counter, origin_device_id
                      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                          generation = excluded.generation,
                    hlc_physical_ms = excluded.hlc_physical_ms,
                    hlc_logical_counter = excluded.hlc_logical_counter,
                    origin_device_id = excluded.origin_device_id,
                    deleted_at = CURRENT_TIMESTAMP",
                params![
                    change.entity_type.as_str(),
                    change.entity_id,
                    change.generation,
                    change.hlc.physical_ms,
                    change.hlc.logical_counter,
                    change.origin_device_id,
                ],
            )
            .map_err(|error| error.to_string())?;
    } else {
        transaction
            .execute(
                "DELETE FROM sync_tombstones WHERE entity_type = ?1 AND entity_id = ?2",
                params![change.entity_type.as_str(), change.entity_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn merge_validated_changes(
    transaction: &Transaction<'_>,
    changes: &[SyncChange],
    payloads: &[Option<String>],
) -> Result<SyncMergeResult, String> {
    let mut accepted = 0;
    let mut applied = 0;
    let mut ignored = 0;
    let mut conflicts = 0;
    for (change, payload_json) in changes.iter().zip(payloads.iter()) {
        let already_present: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sync_journal WHERE change_id = ?1
                    UNION ALL
                    SELECT 1 FROM sync_entity_versions WHERE winning_change_id = ?1
                 )",
                [&change.change_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if already_present {
            ignored += 1;
            continue;
        }
        observe_timestamp(transaction, change.hlc)?;
        append_remote_change(transaction, change, payload_json.as_deref())?;
        accepted += 1;
        if let Some(blocker) = blocking_tombstone(transaction, change)? {
            record_conflict(transaction, change, payload_json.as_deref(), &blocker)?;
            ignored += 1;
            conflicts += 1;
            continue;
        }
        if incoming_change_wins(transaction, change)? {
            match change.operation {
                SyncOperation::Upsert => materialize_remote_upsert(transaction, change)?,
                SyncOperation::Delete => materialize_remote_delete(transaction, change)?,
            }
            store_remote_winner(transaction, change, payload_json.as_deref())?;
            applied += 1;
        } else {
            let version = stored_version(transaction, change.entity_type, &change.entity_id)?
                .ok_or_else(|| "The winning sync revision is missing".to_string())?;
            record_conflict(
                transaction,
                change,
                payload_json.as_deref(),
                &ConflictBlocker {
                    reason: "older_revision",
                    entity_type: change.entity_type,
                    entity_id: change.entity_id.clone(),
                    version,
                },
            )?;
            ignored += 1;
            conflicts += 1;
        }
    }
    Ok(SyncMergeResult {
        received: changes.len(),
        accepted,
        applied,
        ignored,
        conflicts,
    })
}

pub fn merge_sync_changes(
    app_data_dir: &Path,
    database_url: &str,
    changes: Vec<SyncChange>,
) -> Result<SyncMergeResult, String> {
    if changes
        .windows(2)
        .any(|pair| pair[0].sequence >= pair[1].sequence)
    {
        return Err("Remote sync changes must have increasing sequence numbers".into());
    }
    let payloads = changes
        .iter()
        .map(validate_sync_change)
        .collect::<Result<Vec<_>, _>>()?;
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let result = merge_validated_changes(&transaction, &changes, &payloads)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn merge_sync_changes_from_peer(
    app_data_dir: &Path,
    database_url: &str,
    peer_device_id: &str,
    changes: Vec<SyncChange>,
) -> Result<SyncMergeResult, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    if changes
        .windows(2)
        .any(|pair| pair[0].sequence >= pair[1].sequence)
    {
        return Err("Remote sync changes must have increasing sequence numbers".into());
    }
    let payloads = changes
        .iter()
        .map(validate_sync_change)
        .collect::<Result<Vec<_>, _>>()?;
    let source_cursor = changes.last().map(|change| change.sequence);
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let result = merge_validated_changes(&transaction, &changes, &payloads)?;
    if let Some(source_cursor) = source_cursor {
        transaction
            .execute(
                "INSERT INTO sync_peer_cursors (peer_device_id, cursor_kind, sequence)
                 VALUES (?1, 'pulled', ?2)
                 ON CONFLICT(peer_device_id, cursor_kind) DO UPDATE SET
                    sequence = MAX(sync_peer_cursors.sequence, excluded.sequence),
                    updated_at = CURRENT_TIMESTAMP",
                params![peer_device_id, source_cursor],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub fn apply_sync_snapshot(
    app_data_dir: &Path,
    database_url: &str,
    peer_device_id: &str,
    snapshot: SyncSnapshot,
) -> Result<SyncMergeResult, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let payloads = validate_sync_snapshot(&snapshot)?;
    let mut connection = open_database(app_data_dir, database_url)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let result = merge_validated_changes(&transaction, &snapshot.changes, &payloads)?;
    transaction
        .execute(
            "INSERT INTO sync_peer_cursors (peer_device_id, cursor_kind, sequence)
             VALUES (?1, 'pulled', ?2)
             ON CONFLICT(peer_device_id, cursor_kind) DO UPDATE SET
                sequence = MAX(sync_peer_cursors.sequence, excluded.sequence),
                updated_at = CURRENT_TIMESTAMP",
            params![peer_device_id, snapshot.base_cursor],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);
    const DATABASE_URL: &str = "sqlite:sync-test.db";
    const DEVICE_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const SECOND_DEVICE_ID: &str = "7b2cd5dc-c12c-43f6-86f6-4e3b51b0dc49";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("rollmap-sync-{name}-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn connection(&self) -> Connection {
            Connection::open(self.0.join("sync-test.db")).expect("open test database")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn position(id: &str) -> Position {
        Position {
            id: id.into(),
            name: format!("Position {id}"),
            aliases: Vec::new(),
            description: String::new(),
            category: "guard".into(),
            role: "bottom".into(),
            tags: Vec::new(),
            x: 10.0,
            y: 20.0,
        }
    }

    fn technique(id: &str, source: &str, target: Option<&str>) -> Technique {
        Technique {
            id: id.into(),
            source_position_id: source.into(),
            target_position_id: target.map(str::to_owned),
            name: format!("Technique {id}"),
            description: String::new(),
            gi_mode: "both".into(),
            difficulty: "foundation".into(),
            tags: Vec::new(),
        }
    }

    fn attachment(id: &str, owner_type: &str, owner_id: &str) -> Attachment {
        Attachment {
            id: id.into(),
            owner_type: owner_type.into(),
            owner_id: owner_id.into(),
            kind: "note".into(),
            title: "Cue".into(),
            value: "Keep posture".into(),
            blob_hash: None,
            mime_type: None,
            file_extension: None,
            byte_size: None,
        }
    }

    fn prepare(directory: &TestDirectory) {
        crate::storage::prepare_graph_database(&directory.0, DATABASE_URL)
            .expect("prepare graph database");
        bootstrap_database(&directory.0, DATABASE_URL, DEVICE_ID).expect("bootstrap sync store");
    }

    #[test]
    fn bootstraps_existing_records_once() {
        let directory = TestDirectory::new("baseline");
        crate::storage::prepare_graph_database(&directory.0, DATABASE_URL)
            .expect("prepare graph database");
        let connection = directory.connection();
        connection
            .execute_batch(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0);
                 INSERT INTO techniques (
                    id, source_position_id, target_position_id, name, gi_mode, difficulty
                 ) VALUES ('t1', 'p1', NULL, 'Follow-up', 'both', 'foundation');
                 INSERT INTO attachments (id, owner_type, owner_id, kind, title, value)
                 VALUES ('a1', 'technique', 't1', 'note', 'Cue', 'Frame');",
            )
            .expect("seed existing graph");
        drop(connection);

        bootstrap_database(&directory.0, DATABASE_URL, DEVICE_ID).expect("bootstrap records");
        bootstrap_database(&directory.0, DATABASE_URL, DEVICE_ID).expect("repeat bootstrap");

        let connection = directory.connection();
        let journal_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get(0))
            .expect("count journal");
        assert_eq!(journal_count, 4);
        let version_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_entity_versions", [], |row| {
                row.get(0)
            })
            .expect("count versions");
        assert_eq!(version_count, 4);
        let live_payload_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sync_entity_versions
                 WHERE is_deleted = 0 AND payload_json IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count version payloads");
        assert_eq!(live_payload_count, 4);
    }

    #[test]
    fn records_monotonic_changes_and_keeps_layout_independent() {
        let directory = TestDirectory::new("hlc");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::MovePosition {
                position_id: "p1".into(),
                coordinates: Coordinates { x: 30.0, y: 40.0 },
            },
        )
        .expect("move position");

        let connection = directory.connection();
        let mut statement = connection
            .prepare(
                "SELECT hlc_physical_ms, hlc_logical_counter
                 FROM sync_journal ORDER BY sequence",
            )
            .expect("prepare HLC query");
        let timestamps = statement
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
            .expect("query HLC values")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect HLC values");
        assert_eq!(timestamps.len(), 3);
        assert!(timestamps.windows(2).all(|pair| pair[0] < pair[1]));

        let position_payload: String = connection
            .query_row(
                "SELECT payload_json FROM sync_journal
                 WHERE entity_type = 'position' ORDER BY sequence DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read position payload");
        let position_payload: Value =
            serde_json::from_str(&position_payload).expect("parse payload");
        assert!(position_payload.get("x").is_none());
        assert!(position_payload.get("y").is_none());
        let coordinates: (f64, f64) = connection
            .query_row("SELECT x, y FROM positions WHERE id = 'p1'", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("read coordinates");
        assert_eq!(coordinates, (30.0, 40.0));
    }

    #[test]
    fn records_tombstones_for_every_cascaded_delete() {
        let directory = TestDirectory::new("cascade");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: KnowledgeGraph {
                    positions: vec![position("p1"), position("p2")],
                    techniques: vec![technique("t1", "p1", Some("p2"))],
                    attachments: vec![
                        attachment("a1", "position", "p1"),
                        attachment("a2", "technique", "t1"),
                    ],
                },
            },
        )
        .expect("import graph");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete position");

        let connection = directory.connection();
        let tombstones = connection
            .prepare(
                "SELECT entity_type, entity_id FROM sync_tombstones
                 ORDER BY entity_type, entity_id",
            )
            .expect("prepare tombstone query")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query tombstones")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect tombstones");
        assert_eq!(
            tombstones,
            vec![
                ("attachment".into(), "a1".into()),
                ("attachment".into(), "a2".into()),
                ("position".into(), "p1".into()),
                ("position_layout".into(), "p1".into()),
                ("technique".into(), "t1".into()),
            ]
        );
        let remaining: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques),
                    (SELECT COUNT(*) FROM attachments)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count graph records");
        assert_eq!(remaining, (1, 0, 0));
    }

    #[test]
    fn restores_and_redeletes_a_cascaded_graph_snapshot() {
        let directory = TestDirectory::new("history-snapshot");
        prepare(&directory);
        let original = KnowledgeGraph {
            positions: vec![position("p1"), position("p2")],
            techniques: vec![technique("t1", "p1", Some("p2"))],
            attachments: vec![
                attachment("a1", "position", "p1"),
                attachment("a2", "technique", "t1"),
            ],
        };
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: original.clone(),
            },
        )
        .expect("import graph");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete position");

        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::RestoreHistorySnapshot {
                graph: original.clone(),
            },
        )
        .expect("undo delete");

        let connection = directory.connection();
        let restored: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques),
                    (SELECT COUNT(*) FROM attachments)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count restored graph records");
        assert_eq!(restored, (2, 1, 2));
        let restored_generations: Vec<i64> = connection
            .prepare(
                "SELECT generation FROM sync_entity_versions
                 WHERE entity_id IN ('p1', 't1', 'a1', 'a2')
                 ORDER BY entity_type, entity_id",
            )
            .expect("prepare restored generation query")
            .query_map([], |row| row.get(0))
            .expect("query restored generations")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect restored generations");
        assert_eq!(restored_generations, vec![1, 1, 1, 1, 1]);
        drop(connection);

        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::RestoreHistorySnapshot {
                graph: KnowledgeGraph {
                    positions: vec![position("p2")],
                    techniques: Vec::new(),
                    attachments: Vec::new(),
                },
            },
        )
        .expect("redo delete");

        let connection = directory.connection();
        let redeleted: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques),
                    (SELECT COUNT(*) FROM attachments)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count graph records after redo");
        assert_eq!(redeleted, (1, 0, 0));
    }

    #[test]
    fn history_restore_records_only_changed_position_components() {
        let directory = TestDirectory::new("history-position-diff");
        prepare(&directory);
        let original = position("p1");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: original.clone(),
            },
        )
        .expect("save original position");

        let mut moved = original;
        moved.x = 42.0;
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::RestoreHistorySnapshot {
                graph: KnowledgeGraph {
                    positions: vec![moved.clone()],
                    techniques: Vec::new(),
                    attachments: Vec::new(),
                },
            },
        )
        .expect("restore moved position");

        let mut renamed = moved;
        renamed.name = "Renamed position".into();
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::RestoreHistorySnapshot {
                graph: KnowledgeGraph {
                    positions: vec![renamed],
                    techniques: Vec::new(),
                    attachments: Vec::new(),
                },
            },
        )
        .expect("restore renamed position");

        let entity_types = directory
            .connection()
            .prepare("SELECT entity_type FROM sync_journal ORDER BY sequence")
            .expect("prepare entity type query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query entity types")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect entity types");
        assert_eq!(
            entity_types,
            vec!["position", "position_layout", "position_layout", "position"]
        );
    }

    #[test]
    fn rolls_back_the_entity_and_journal_together() {
        let directory = TestDirectory::new("rollback");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save source position");
        let before: i64 = directory
            .connection()
            .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get(0))
            .expect("count journal before failure");

        let error = apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SaveTechnique {
                technique: technique("t1", "missing", None),
            },
        )
        .expect_err("reject missing source position");
        assert!(error.contains("FOREIGN KEY"));

        let connection = directory.connection();
        let after: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get(0))
            .expect("count journal after failure");
        assert_eq!(after, before);
        let technique_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM techniques", [], |row| row.get(0))
            .expect("count techniques");
        assert_eq!(technique_count, 0);
    }

    #[test]
    fn pages_changes_and_advances_peer_cursors_monotonically() {
        let directory = TestDirectory::new("paging");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: KnowledgeGraph {
                    positions: vec![position("p1"), position("p2")],
                    techniques: vec![technique("t1", "p1", Some("p2"))],
                    attachments: Vec::new(),
                },
            },
        )
        .expect("import graph");

        let first = read_sync_changes(&directory.0, DATABASE_URL, 0, 2).expect("first page");
        assert_eq!(first.changes.len(), 2);
        assert!(first.has_more);
        assert!(!first.requires_snapshot);
        assert_eq!(first.journal_floor, 0);
        assert_eq!(first.current_cursor, 5);
        assert_eq!(first.next_cursor, first.changes[1].sequence);
        assert_eq!(first.changes[0].entity_type, SyncEntityType::Position);
        assert!(first.changes[0].payload.is_some());

        let second = read_sync_changes(&directory.0, DATABASE_URL, first.next_cursor, 500)
            .expect("second page");
        assert_eq!(second.changes.len(), 3);
        assert!(!second.has_more);
        assert!(second.changes[0].sequence > first.next_cursor);

        let peer_id = "7b2cd5dc-c12c-43f6-86f6-4e3b51b0dc49";
        assert_eq!(
            read_peer_cursor(&directory.0, DATABASE_URL, peer_id, PeerCursorKind::Pulled,)
                .expect("read default cursor"),
            0
        );
        assert_eq!(
            update_peer_cursor(
                &directory.0,
                DATABASE_URL,
                peer_id,
                PeerCursorKind::Pulled,
                second.next_cursor,
            )
            .expect("advance cursor"),
            second.next_cursor
        );
        assert_eq!(
            read_peer_cursor(&directory.0, DATABASE_URL, peer_id, PeerCursorKind::Pulled,)
                .expect("read advanced cursor"),
            second.next_cursor
        );
        assert_eq!(
            update_peer_cursor(
                &directory.0,
                DATABASE_URL,
                peer_id,
                PeerCursorKind::Pulled,
                1,
            )
            .expect("reject cursor regression"),
            second.next_cursor
        );
    }

    #[test]
    fn rejects_acknowledgements_beyond_the_current_journal_cursor() {
        let directory = TestDirectory::new("future-acknowledgement");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");

        let error = update_peer_cursor(
            &directory.0,
            DATABASE_URL,
            SECOND_DEVICE_ID,
            PeerCursorKind::Acknowledged,
            3,
        )
        .expect_err("reject acknowledgement beyond current journal");
        assert!(error.contains("cannot exceed current journal cursor"));
        assert_eq!(
            read_peer_cursor(
                &directory.0,
                DATABASE_URL,
                SECOND_DEVICE_ID,
                PeerCursorKind::Acknowledged,
            )
            .expect("read unchanged acknowledgement"),
            0
        );
    }

    #[test]
    fn reports_pending_delivery_and_snapshot_requirements() {
        let directory = TestDirectory::new("pending-delivery");
        prepare(&directory);
        let peer_id = "8a362665-8dd6-4e31-9604-97f6b72d9eb0";
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("record local change");

        let pending = pending_sync_delivery(&directory.0, DATABASE_URL, &[peer_id.into()])
            .expect("read pending delivery");
        assert!(pending.pending_changes > 0);
        assert!(!pending.requires_snapshot);

        let current_cursor = read_sync_changes(&directory.0, DATABASE_URL, 0, 500)
            .expect("read current cursor")
            .current_cursor;
        update_peer_cursor(
            &directory.0,
            DATABASE_URL,
            peer_id,
            PeerCursorKind::Acknowledged,
            current_cursor,
        )
        .expect("acknowledge delivery");
        assert_eq!(
            pending_sync_delivery(&directory.0, DATABASE_URL, &[peer_id.into()])
                .expect("read acknowledged delivery"),
            PendingSyncDelivery::default()
        );

        compact_sync_journal(&directory.0, DATABASE_URL, &[]).expect("compact journal");
        let new_peer_id = "c98934ac-9be8-4852-a76b-7385a515c2ef";
        assert!(
            pending_sync_delivery(&directory.0, DATABASE_URL, &[new_peer_id.into()])
                .expect("read stale delivery")
                .requires_snapshot
        );
    }

    #[test]
    fn exports_only_current_winners_in_dependency_order() {
        let directory = TestDirectory::new("snapshot");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: KnowledgeGraph {
                    positions: vec![position("p1"), position("p2")],
                    techniques: vec![technique("t1", "p1", Some("p2"))],
                    attachments: vec![attachment("a1", "technique", "t1")],
                },
            },
        )
        .expect("import graph");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete position");

        let snapshot = read_sync_snapshot(&directory.0, DATABASE_URL).expect("read sync snapshot");
        assert_eq!(snapshot.changes.len(), 6);
        assert!(snapshot.base_cursor > snapshot.changes.len() as i64);
        assert!(snapshot
            .changes
            .iter()
            .all(|change| change.sequence == snapshot.base_cursor));
        assert_eq!(
            snapshot
                .changes
                .iter()
                .map(|change| (change.entity_type, change.entity_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (SyncEntityType::Position, "p2"),
                (SyncEntityType::PositionLayout, "p2"),
                (SyncEntityType::Attachment, "a1"),
                (SyncEntityType::Technique, "t1"),
                (SyncEntityType::PositionLayout, "p1"),
                (SyncEntityType::Position, "p1"),
            ]
        );
        assert!(snapshot.changes[..2]
            .iter()
            .all(|change| change.operation == SyncOperation::Upsert && change.payload.is_some()));
        assert!(snapshot.changes[2..]
            .iter()
            .all(|change| change.operation == SyncOperation::Delete && change.payload.is_none()));

        let connection = directory.connection();
        for change in snapshot.changes {
            let winning_change_id: String = connection
                .query_row(
                    "SELECT winning_change_id FROM sync_entity_versions
                     WHERE entity_type = ?1 AND entity_id = ?2",
                    params![change.entity_type.as_str(), change.entity_id],
                    |row| row.get(0),
                )
                .expect("read winning change ID");
            assert_eq!(change.change_id, winning_change_id);
        }
    }

    #[test]
    fn applies_snapshots_idempotently_after_winner_journal_compaction() {
        let source = TestDirectory::new("snapshot-source");
        let target = TestDirectory::new("snapshot-target");
        prepare(&source);
        crate::storage::prepare_graph_database(&target.0, DATABASE_URL)
            .expect("prepare target database");
        bootstrap_database(&target.0, DATABASE_URL, SECOND_DEVICE_ID)
            .expect("bootstrap target database");
        apply_graph_mutation(
            &source.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: KnowledgeGraph {
                    positions: vec![position("p1"), position("p2")],
                    techniques: vec![technique("t1", "p1", Some("p2"))],
                    attachments: vec![attachment("a1", "technique", "t1")],
                },
            },
        )
        .expect("import source graph");
        apply_graph_mutation(
            &source.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete source position");
        let snapshot = read_sync_snapshot(&source.0, DATABASE_URL).expect("export snapshot");
        let change_count = snapshot.changes.len();
        let base_cursor = snapshot.base_cursor;

        let applied = apply_sync_snapshot(&target.0, DATABASE_URL, DEVICE_ID, snapshot.clone())
            .expect("apply snapshot");
        assert_eq!(applied.received, change_count);
        assert_eq!(applied.accepted, change_count);
        assert_eq!(applied.applied, change_count);
        let target_counts: (i64, i64, i64, i64) = target
            .connection()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques),
                    (SELECT COUNT(*) FROM attachments),
                    (SELECT COUNT(*) FROM sync_tombstones)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("count applied snapshot records");
        assert_eq!(target_counts, (1, 0, 0, 4));
        let pulled_cursor: i64 = target
            .connection()
            .query_row(
                "SELECT sequence FROM sync_peer_cursors
                 WHERE peer_device_id = ?1 AND cursor_kind = 'pulled'",
                [DEVICE_ID],
                |row| row.get(0),
            )
            .expect("read snapshot cursor");
        assert_eq!(pulled_cursor, base_cursor);

        let connection = target.connection();
        let compacted_through: i64 = connection
            .query_row("SELECT MAX(sequence) FROM sync_journal", [], |row| {
                row.get(0)
            })
            .expect("read target journal cursor");
        connection
            .execute("DELETE FROM sync_journal", [])
            .expect("compact target journal");
        connection
            .execute(
                "UPDATE sync_store_meta SET value = ?1 WHERE key = 'journal_floor'",
                [compacted_through.to_string()],
            )
            .expect("record target journal floor");
        drop(connection);

        let retried = apply_sync_snapshot(&target.0, DATABASE_URL, DEVICE_ID, snapshot)
            .expect("retry compacted snapshot");
        assert_eq!(retried.accepted, 0);
        assert_eq!(retried.applied, 0);
        assert_eq!(retried.ignored, change_count);
        assert_eq!(
            target
                .connection()
                .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count journal after retry"),
            0
        );
    }

    #[test]
    fn rolls_back_snapshot_records_and_cursor_together() {
        let directory = TestDirectory::new("snapshot-rollback");
        prepare(&directory);
        let snapshot = SyncSnapshot {
            base_cursor: 2,
            changes: vec![
                SyncChange {
                    sequence: 2,
                    change_id: "104873f7-fe02-447c-bf16-1ad3b88d7087".into(),
                    entity_type: SyncEntityType::Position,
                    entity_id: "p1".into(),
                    operation: SyncOperation::Upsert,
                    generation: 0,
                    hlc: HybridTimestamp {
                        physical_ms: 1,
                        logical_counter: 0,
                    },
                    origin_device_id: SECOND_DEVICE_ID.into(),
                    payload: Some(
                        serde_json::from_str(
                            &position_entity_payload(&position("p1")).expect("position payload"),
                        )
                        .expect("parse position payload"),
                    ),
                },
                SyncChange {
                    sequence: 2,
                    change_id: "84ef9237-307d-45c7-b5c2-121d5e24bc3f".into(),
                    entity_type: SyncEntityType::Technique,
                    entity_id: "t1".into(),
                    operation: SyncOperation::Upsert,
                    generation: 0,
                    hlc: HybridTimestamp {
                        physical_ms: 2,
                        logical_counter: 0,
                    },
                    origin_device_id: SECOND_DEVICE_ID.into(),
                    payload: Some(
                        serde_json::to_value(technique("t1", "missing", None))
                            .expect("technique payload"),
                    ),
                },
            ],
        };

        let error = apply_sync_snapshot(&directory.0, DATABASE_URL, SECOND_DEVICE_ID, snapshot)
            .expect_err("reject invalid snapshot");
        assert!(error.contains("FOREIGN KEY"));
        let counts: (i64, i64, i64) = directory
            .connection()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM sync_journal),
                    (SELECT COUNT(*) FROM sync_peer_cursors)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count rolled back snapshot state");
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn signals_a_cursor_behind_the_journal_floor() {
        let directory = TestDirectory::new("stale-cursor");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");
        directory
            .connection()
            .execute(
                "UPDATE sync_store_meta SET value = '1' WHERE key = 'journal_floor'",
                [],
            )
            .expect("advance journal floor");

        let stale = read_sync_changes(&directory.0, DATABASE_URL, 0, 500)
            .expect("read stale cursor response");
        assert!(stale.requires_snapshot);
        assert!(stale.changes.is_empty());
        assert_eq!(stale.next_cursor, 0);
        assert_eq!(stale.journal_floor, 1);
        assert_eq!(stale.current_cursor, 2);

        let current = read_sync_changes(&directory.0, DATABASE_URL, 1, 500)
            .expect("read current cursor response");
        assert!(!current.requires_snapshot);
        assert_eq!(current.changes.len(), 1);
    }

    #[test]
    fn compacts_only_through_every_required_peers_acknowledgement() {
        let directory = TestDirectory::new("compaction");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete position");
        let third_peer_id = "84ef9237-307d-45c7-b5c2-121d5e24bc3f";
        let required_peers = vec![SECOND_DEVICE_ID.to_string(), third_peer_id.to_string()];
        update_peer_cursor(
            &directory.0,
            DATABASE_URL,
            SECOND_DEVICE_ID,
            PeerCursorKind::Acknowledged,
            4,
        )
        .expect("acknowledge first peer");

        let blocked =
            compact_sync_journal(&directory.0, DATABASE_URL, &required_peers).expect("compact");
        assert_eq!(blocked.deleted_changes, 0);
        assert_eq!(blocked.compacted_through, 0);
        assert_eq!(blocked.blocked_by_peer_ids, vec![third_peer_id]);
        assert_eq!(blocked.required_peer_count, 2);

        update_peer_cursor(
            &directory.0,
            DATABASE_URL,
            third_peer_id,
            PeerCursorKind::Acknowledged,
            3,
        )
        .expect("acknowledge second peer");
        let compacted =
            compact_sync_journal(&directory.0, DATABASE_URL, &required_peers).expect("compact");
        assert_eq!(compacted.previous_floor, 0);
        assert_eq!(compacted.compacted_through, 3);
        assert_eq!(compacted.deleted_changes, 3);
        assert!(compacted.blocked_by_peer_ids.is_empty());

        let connection = directory.connection();
        let retained: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM sync_journal),
                    (SELECT COUNT(*) FROM sync_entity_versions),
                    (SELECT COUNT(*) FROM sync_tombstones)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count retained sync state");
        assert_eq!(retained, (1, 2, 2));
        drop(connection);

        let stale =
            read_sync_changes(&directory.0, DATABASE_URL, 0, 500).expect("read compacted cursor");
        assert!(stale.requires_snapshot);
        assert_eq!(stale.journal_floor, 3);
        let incremental = read_sync_changes(&directory.0, DATABASE_URL, 3, 500)
            .expect("read retained journal tail");
        assert_eq!(incremental.changes.len(), 1);
        let snapshot =
            read_sync_snapshot(&directory.0, DATABASE_URL).expect("read retained winners");
        assert_eq!(snapshot.changes.len(), 2);
        assert!(snapshot
            .changes
            .iter()
            .all(|change| change.operation == SyncOperation::Delete));
    }

    #[test]
    fn compacts_to_the_current_cursor_when_no_peer_requires_history() {
        let directory = TestDirectory::new("compaction-no-peers");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");

        let compacted =
            compact_sync_journal(&directory.0, DATABASE_URL, &[]).expect("compact journal");
        assert_eq!(compacted.compacted_through, 2);
        assert_eq!(compacted.deleted_changes, 2);
        assert_eq!(compacted.required_peer_count, 0);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p2"),
            },
        )
        .expect("save after compaction");
        let tail = read_sync_changes(&directory.0, DATABASE_URL, 2, 500)
            .expect("read post-compaction changes");
        assert_eq!(tail.changes.len(), 2);
        assert_eq!(tail.changes[0].sequence, 3);
    }

    #[test]
    fn merges_changes_bidirectionally_and_deduplicates_retries() {
        let first = TestDirectory::new("merge-first");
        let second = TestDirectory::new("merge-second");
        prepare(&first);
        crate::storage::prepare_graph_database(&second.0, DATABASE_URL)
            .expect("prepare second database");
        bootstrap_database(&second.0, DATABASE_URL, SECOND_DEVICE_ID)
            .expect("bootstrap second database");
        apply_graph_mutation(
            &first.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::ImportGraph {
                graph: KnowledgeGraph {
                    positions: vec![position("p1"), position("p2")],
                    techniques: vec![technique("t1", "p1", Some("p2"))],
                    attachments: Vec::new(),
                },
            },
        )
        .expect("write first database");
        let first_batch =
            read_sync_changes(&first.0, DATABASE_URL, 0, 500).expect("read first changes");

        let merged = merge_sync_changes(&second.0, DATABASE_URL, first_batch.changes.clone())
            .expect("merge into second database");
        assert_eq!(merged.received, 5);
        assert_eq!(merged.accepted, 5);
        assert_eq!(merged.applied, 5);
        assert_eq!(merged.ignored, 0);
        let second_counts: (i64, i64) = second
            .connection()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count second graph");
        assert_eq!(second_counts, (2, 1));

        let before_retry_clock: (i64, i64) = second
            .connection()
            .query_row(
                "SELECT physical_ms, logical_counter FROM sync_hlc_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read clock before retry");
        let retried = merge_sync_changes(&second.0, DATABASE_URL, first_batch.changes.clone())
            .expect("deduplicate retry");
        assert_eq!(retried.accepted, 0);
        assert_eq!(retried.applied, 0);
        assert_eq!(retried.ignored, 5);
        let after_retry_clock: (i64, i64) = second
            .connection()
            .query_row(
                "SELECT physical_ms, logical_counter FROM sync_hlc_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read clock after retry");
        assert_eq!(after_retry_clock, before_retry_clock);

        let mut changed_position = position("p1");
        changed_position.name = "Second device guard".into();
        apply_graph_mutation(
            &second.0,
            DATABASE_URL,
            SECOND_DEVICE_ID,
            GraphMutation::SavePosition {
                position: changed_position,
            },
        )
        .expect("edit on second device");
        let second_batch =
            read_sync_changes(&second.0, DATABASE_URL, 0, 500).expect("read second changes");
        assert_eq!(second_batch.changes.len(), 7);
        let second_cursor = second_batch.next_cursor;
        let merged_back = merge_sync_changes(&first.0, DATABASE_URL, second_batch.changes)
            .expect("merge back into first database");
        assert_eq!(merged_back.accepted, 2);
        assert_eq!(merged_back.applied, 2);
        assert_eq!(merged_back.ignored, 5);
        let first_name: String = first
            .connection()
            .query_row("SELECT name FROM positions WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .expect("read merged position");
        assert_eq!(first_name, "Second device guard");

        apply_graph_mutation(
            &first.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete on first device");
        let deletion_batch = read_sync_changes(&first.0, DATABASE_URL, second_cursor, 500)
            .expect("read deletion changes");
        assert_eq!(deletion_batch.changes.len(), 3);
        assert!(deletion_batch
            .changes
            .iter()
            .all(|change| change.operation == SyncOperation::Delete));
        merge_sync_changes(&second.0, DATABASE_URL, deletion_batch.changes)
            .expect("merge deletions into second database");
        let remaining: (i64, i64) = second
            .connection()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count graph after remote delete");
        assert_eq!(remaining, (1, 0));
        let tombstone_count: i64 = second
            .connection()
            .query_row("SELECT COUNT(*) FROM sync_tombstones", [], |row| row.get(0))
            .expect("count remote tombstones");
        assert_eq!(tombstone_count, 3);
    }

    #[test]
    fn delete_and_upsert_converge_regardless_of_arrival_order() {
        let delete_first = TestDirectory::new("delete-first");
        let upsert_first = TestDirectory::new("upsert-first");
        prepare(&delete_first);
        prepare(&upsert_first);

        let mut updated_position = position("p1");
        updated_position.name = "Newer remote update".into();
        let upsert = SyncChange {
            sequence: 2,
            change_id: "2fa5df14-7632-4801-89d7-b83d82867d31".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Upsert,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: 200,
                logical_counter: 0,
            },
            origin_device_id: DEVICE_ID.into(),
            payload: Some(
                serde_json::from_str(
                    &position_entity_payload(&updated_position).expect("position payload"),
                )
                .expect("parse position payload"),
            ),
        };
        let delete = SyncChange {
            sequence: 1,
            change_id: "119697b0-f8a1-407d-be4f-a0dd81778c77".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Delete,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: 100,
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: None,
        };

        merge_sync_changes(&delete_first.0, DATABASE_URL, vec![delete.clone()])
            .expect("apply delete first");
        merge_sync_changes(&delete_first.0, DATABASE_URL, vec![upsert.clone()])
            .expect("apply upsert after delete");
        merge_sync_changes(&upsert_first.0, DATABASE_URL, vec![upsert])
            .expect("apply upsert first");
        merge_sync_changes(&upsert_first.0, DATABASE_URL, vec![delete.clone()])
            .expect("apply delete after upsert");

        for directory in [&delete_first, &upsert_first] {
            let state: (i64, i64, String) = directory
                .connection()
                .query_row(
                    "SELECT
                        (SELECT COUNT(*) FROM positions WHERE id = 'p1'),
                        (SELECT COUNT(*) FROM sync_tombstones
                         WHERE entity_type = 'position' AND entity_id = 'p1'),
                        (SELECT winning_change_id FROM sync_entity_versions
                         WHERE entity_type = 'position' AND entity_id = 'p1')",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("read converged delete state");
            assert_eq!(state, (0, 1, delete.change_id.clone()));

            let snapshot =
                read_sync_snapshot(&directory.0, DATABASE_URL).expect("read converged snapshot");
            let winner = snapshot
                .changes
                .iter()
                .find(|change| {
                    change.entity_type == SyncEntityType::Position && change.entity_id == "p1"
                })
                .expect("find position winner");
            assert_eq!(winner.change_id, delete.change_id);
            assert_eq!(winner.operation, SyncOperation::Delete);
        }
    }

    #[test]
    fn restored_generation_beats_older_delete_regardless_of_arrival_order() {
        let delete_first = TestDirectory::new("generation-delete-first");
        let restore_first = TestDirectory::new("generation-restore-first");
        prepare(&delete_first);
        prepare(&restore_first);

        let restored_position = position("p1");
        let restore = SyncChange {
            sequence: 2,
            change_id: "cd5a7e7f-e20e-4c85-b251-51b8aac9cf1a".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Upsert,
            generation: 1,
            hlc: HybridTimestamp {
                physical_ms: 200,
                logical_counter: 0,
            },
            origin_device_id: DEVICE_ID.into(),
            payload: Some(
                serde_json::from_str(
                    &position_entity_payload(&restored_position).expect("position payload"),
                )
                .expect("parse position payload"),
            ),
        };
        let delete = SyncChange {
            sequence: 1,
            change_id: "f6619bda-bcf1-4765-a1bf-3db31042cbfa".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Delete,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: 300,
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: None,
        };

        merge_sync_changes(&delete_first.0, DATABASE_URL, vec![delete.clone()])
            .expect("apply older delete first");
        merge_sync_changes(&delete_first.0, DATABASE_URL, vec![restore.clone()])
            .expect("apply restored generation after delete");
        merge_sync_changes(&restore_first.0, DATABASE_URL, vec![restore])
            .expect("apply restored generation first");
        merge_sync_changes(&restore_first.0, DATABASE_URL, vec![delete])
            .expect("ignore older delete after restore");

        for directory in [&delete_first, &restore_first] {
            let connection = directory.connection();
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM positions WHERE id = 'p1'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("count restored position"),
                1
            );
            let winner: (i64, bool) = connection
                .query_row(
                    "SELECT generation, is_deleted FROM sync_entity_versions
                     WHERE entity_type = 'position' AND entity_id = 'p1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read restored winner");
            assert_eq!(winner, (1, false));
        }
    }

    #[test]
    fn rolls_back_an_invalid_remote_batch() {
        let directory = TestDirectory::new("invalid-remote");
        prepare(&directory);
        let invalid = SyncChange {
            sequence: 1,
            change_id: "104873f7-fe02-447c-bf16-1ad3b88d7087".into(),
            entity_type: SyncEntityType::Technique,
            entity_id: "t1".into(),
            operation: SyncOperation::Upsert,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: current_time_ms().expect("current time"),
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: Some(
                serde_json::to_value(technique("t1", "missing", None))
                    .expect("serialize invalid technique"),
            ),
        };

        let error = merge_sync_changes(&directory.0, DATABASE_URL, vec![invalid])
            .expect_err("reject invalid remote batch");
        assert!(error.contains("FOREIGN KEY"));
        let connection = directory.connection();
        let journal_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get(0))
            .expect("count journal");
        assert_eq!(journal_count, 0);
        let clock: (i64, i64) = connection
            .query_row(
                "SELECT physical_ms, logical_counter FROM sync_hlc_state WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read rolled back clock");
        assert_eq!(clock, (0, 0));
    }

    #[test]
    fn advances_the_source_peer_cursor_with_the_incremental_merge() {
        let source = TestDirectory::new("peer-merge-source");
        let target = TestDirectory::new("peer-merge-target");
        prepare(&source);
        crate::storage::prepare_graph_database(&target.0, DATABASE_URL)
            .expect("prepare target database");
        bootstrap_database(&target.0, DATABASE_URL, SECOND_DEVICE_ID)
            .expect("bootstrap target database");
        apply_graph_mutation(
            &source.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save source position");
        let batch =
            read_sync_changes(&source.0, DATABASE_URL, 0, 500).expect("read source changes");

        let merged =
            merge_sync_changes_from_peer(&target.0, DATABASE_URL, DEVICE_ID, batch.changes)
                .expect("merge peer changes");
        assert_eq!(merged.applied, 2);
        let pulled_cursor: i64 = target
            .connection()
            .query_row(
                "SELECT sequence FROM sync_peer_cursors
                 WHERE peer_device_id = ?1 AND cursor_kind = 'pulled'",
                [DEVICE_ID],
                |row| row.get(0),
            )
            .expect("read pulled cursor");
        assert_eq!(pulled_cursor, 2);

        let invalid = SyncChange {
            sequence: 3,
            change_id: "104873f7-fe02-447c-bf16-1ad3b88d7087".into(),
            entity_type: SyncEntityType::Technique,
            entity_id: "t1".into(),
            operation: SyncOperation::Upsert,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: current_time_ms().expect("current time"),
                logical_counter: 0,
            },
            origin_device_id: DEVICE_ID.into(),
            payload: Some(
                serde_json::to_value(technique("t1", "missing", None))
                    .expect("serialize invalid technique"),
            ),
        };
        assert!(
            merge_sync_changes_from_peer(&target.0, DATABASE_URL, DEVICE_ID, vec![invalid],)
                .expect_err("reject invalid peer batch")
                .contains("FOREIGN KEY")
        );
        let cursor_after_failure: i64 = target
            .connection()
            .query_row(
                "SELECT sequence FROM sync_peer_cursors
                 WHERE peer_device_id = ?1 AND cursor_kind = 'pulled'",
                [DEVICE_ID],
                |row| row.get(0),
            )
            .expect("read cursor after failure");
        assert_eq!(cursor_after_failure, pulled_cursor);
    }

    #[test]
    fn rejects_tombstone_reuse_and_audits_remote_conflicts() {
        let directory = TestDirectory::new("conflicts");
        prepare(&directory);
        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect("save position");

        let mut old_position = position("p1");
        old_position.name = "Old remote name".into();
        let older_revision = SyncChange {
            sequence: 1,
            change_id: "104873f7-fe02-447c-bf16-1ad3b88d7087".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Upsert,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: 1,
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: Some(
                serde_json::from_str(
                    &position_entity_payload(&old_position).expect("position payload"),
                )
                .expect("parse position payload"),
            ),
        };
        let older_result = merge_sync_changes(&directory.0, DATABASE_URL, vec![older_revision])
            .expect("audit older revision");
        assert_eq!(older_result.accepted, 1);
        assert_eq!(older_result.applied, 0);
        assert_eq!(older_result.conflicts, 1);

        apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::DeletePosition {
                position_id: "p1".into(),
            },
        )
        .expect("delete position");
        let journal_before_reuse: i64 = directory
            .connection()
            .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| row.get(0))
            .expect("count journal before reuse");
        let reuse_error = apply_graph_mutation(
            &directory.0,
            DATABASE_URL,
            DEVICE_ID,
            GraphMutation::SavePosition {
                position: position("p1"),
            },
        )
        .expect_err("reject local identity reuse");
        assert!(reuse_error.contains("cannot be reused"));
        assert_eq!(
            directory
                .connection()
                .query_row("SELECT COUNT(*) FROM sync_journal", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count journal after reuse"),
            journal_before_reuse
        );

        let tombstone_hlc: (i64, i64) = directory
            .connection()
            .query_row(
                "SELECT hlc_physical_ms, hlc_logical_counter
                 FROM sync_tombstones
                 WHERE entity_type = 'position' AND entity_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read position tombstone");
        let deleted_entity = SyncChange {
            sequence: 2,
            change_id: "84ef9237-307d-45c7-b5c2-121d5e24bc3f".into(),
            entity_type: SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: SyncOperation::Upsert,
            generation: 0,
            hlc: HybridTimestamp {
                physical_ms: tombstone_hlc.0 + 1,
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: Some(
                serde_json::from_str(
                    &position_entity_payload(&position("p1")).expect("position payload"),
                )
                .expect("parse position payload"),
            ),
        };
        let deleted_result = merge_sync_changes(&directory.0, DATABASE_URL, vec![deleted_entity])
            .expect("audit deleted entity");
        assert_eq!(deleted_result.applied, 0);
        assert_eq!(deleted_result.conflicts, 1);

        let deleted_dependency = SyncChange {
            sequence: 3,
            change_id: "78974652-98df-437a-848b-58f2a92809c9".into(),
            entity_type: SyncEntityType::Technique,
            entity_id: "t1".into(),
            operation: SyncOperation::Upsert,
            generation: 1,
            hlc: HybridTimestamp {
                physical_ms: tombstone_hlc.0 + 2,
                logical_counter: 0,
            },
            origin_device_id: SECOND_DEVICE_ID.into(),
            payload: Some(
                serde_json::to_value(technique("t1", "p1", None)).expect("serialize technique"),
            ),
        };
        let dependency_result =
            merge_sync_changes(&directory.0, DATABASE_URL, vec![deleted_dependency])
                .expect("audit deleted dependency");
        assert_eq!(dependency_result.applied, 0);
        assert_eq!(dependency_result.conflicts, 1);

        let connection = directory.connection();
        let reasons = connection
            .prepare("SELECT reason FROM sync_conflicts ORDER BY reason")
            .expect("prepare conflict query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query conflicts")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect conflicts");
        assert_eq!(
            reasons,
            vec![
                "deleted_dependency".to_string(),
                "deleted_entity".to_string(),
                "older_revision".to_string(),
            ]
        );
        let graph_counts: (i64, i64) = connection
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM positions),
                    (SELECT COUNT(*) FROM techniques)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("count protected graph");
        assert_eq!(graph_counts, (0, 0));
    }
}
