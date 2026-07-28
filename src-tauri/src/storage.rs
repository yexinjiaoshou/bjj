use rusqlite::{backup::Backup, Connection};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct GraphMigration {
    version: i64,
    description: &'static str,
    sql: &'static str,
}

const GRAPH_MIGRATIONS: &[GraphMigration] = &[
    GraphMigration {
        version: 1,
        description: "initial_schema",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    GraphMigration {
        version: 2,
        description: "remove_position_side",
        sql: include_str!("../migrations/0002_remove_position_side.sql"),
    },
    GraphMigration {
        version: 3,
        description: "merge_pin_into_control",
        sql: include_str!("../migrations/0003_merge_pin_into_control.sql"),
    },
    GraphMigration {
        version: 4,
        description: "allow_unknown_technique_target",
        sql: include_str!("../migrations/0004_allow_unknown_technique_target.sql"),
    },
    GraphMigration {
        version: 5,
        description: "sync_journal",
        sql: include_str!("../migrations/0005_sync_journal.sql"),
    },
    GraphMigration {
        version: 6,
        description: "sync_transport_state",
        sql: include_str!("../migrations/0006_sync_transport_state.sql"),
    },
    GraphMigration {
        version: 7,
        description: "sync_conflicts",
        sql: include_str!("../migrations/0007_sync_conflicts.sql"),
    },
    GraphMigration {
        version: 8,
        description: "snapshot_state",
        sql: include_str!("../migrations/0008_snapshot_state.sql"),
    },
    GraphMigration {
        version: 9,
        description: "media_blobs",
        sql: include_str!("../migrations/0009_media_blobs.sql"),
    },
    GraphMigration {
        version: 10,
        description: "sync_generations",
        sql: include_str!("../migrations/0010_sync_generations.sql"),
    },
];

const LATEST_GRAPH_SCHEMA_VERSION: i64 = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDatabase {
    schema_version: i64,
    backup_relative_path: Option<String>,
}

pub(crate) fn database_filename(database_url: &str) -> Result<&str, String> {
    let filename = database_url
        .strip_prefix("sqlite:")
        .ok_or_else(|| "Knowledge database URL must start with sqlite:".to_string())?;
    let is_safe = !filename.is_empty()
        && filename.ends_with(".db")
        && !filename.starts_with('.')
        && !filename.contains(['/', '\\'])
        && filename
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character));
    if !is_safe {
        return Err("Knowledge database URL must name a local .db file".into());
    }
    Ok(filename)
}

fn table_exists(connection: &Connection, table: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

fn column_not_null(
    connection: &Connection,
    table: &str,
    column: &str,
) -> rusqlite::Result<Option<bool>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            let not_null: i64 = row.get(3)?;
            return Ok(Some(not_null != 0));
        }
    }
    Ok(None)
}

fn trigger_exists(connection: &Connection, trigger: &str) -> rusqlite::Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1)",
        [trigger],
        |row| row.get(0),
    )
}

fn detect_schema_version(connection: &Connection) -> Result<i64, String> {
    if !table_exists(connection, "positions").map_err(|error| error.to_string())? {
        return Ok(0);
    }
    if !table_exists(connection, "techniques").map_err(|error| error.to_string())?
        || !table_exists(connection, "attachments").map_err(|error| error.to_string())?
    {
        return Err("Knowledge database has an incomplete schema".into());
    }
    if column_not_null(connection, "positions", "side")
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(1);
    }
    let target_is_required = column_not_null(connection, "techniques", "target_position_id")
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Knowledge database is missing technique targets".to_string())?;
    if !target_is_required {
        let sync_tables = [
            "sync_hlc_state",
            "sync_store_meta",
            "sync_entity_versions",
            "sync_tombstones",
            "sync_journal",
        ];
        let sync_table_count = sync_tables
            .iter()
            .map(|table| table_exists(connection, table))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|exists| *exists)
            .count();
        if sync_table_count != 0 && sync_table_count != sync_tables.len() {
            return Err("Knowledge database has an incomplete sync schema".into());
        }
        if sync_table_count == 0 {
            return Ok(4);
        }
        let has_version_payload =
            column_not_null(connection, "sync_entity_versions", "payload_json")
                .map_err(|error| error.to_string())?
                .is_some();
        let has_peer_cursors =
            table_exists(connection, "sync_peer_cursors").map_err(|error| error.to_string())?;
        if has_version_payload != has_peer_cursors {
            return Err("Knowledge database has an incomplete sync transport schema".into());
        }
        if !has_version_payload {
            return Ok(5);
        }
        let has_conflicts =
            table_exists(connection, "sync_conflicts").map_err(|error| error.to_string())?;
        if !has_conflicts {
            return Ok(6);
        }
        let has_winning_change_id =
            column_not_null(connection, "sync_entity_versions", "winning_change_id")
                .map_err(|error| error.to_string())?
                .is_some();
        if !has_winning_change_id {
            return Ok(7);
        }
        let has_attachment_blob_hash = column_not_null(connection, "attachments", "blob_hash")
            .map_err(|error| error.to_string())?
            .is_some();
        let has_media_blobs =
            table_exists(connection, "media_blobs").map_err(|error| error.to_string())?;
        if has_attachment_blob_hash != has_media_blobs {
            return Err("Knowledge database has an incomplete media blob schema".into());
        }
        if !has_media_blobs {
            return Ok(8);
        }
        let generation_tables = [
            "sync_entity_versions",
            "sync_tombstones",
            "sync_journal",
            "sync_conflicts",
        ];
        let generation_column_count = generation_tables
            .iter()
            .map(|table| column_not_null(connection, table, "generation"))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(Option::is_some)
            .count();
        let has_winning_generation =
            column_not_null(connection, "sync_conflicts", "winning_generation")
                .map_err(|error| error.to_string())?
                .is_some();
        if (generation_column_count != 0 && generation_column_count != generation_tables.len())
            || (generation_column_count == 0 && has_winning_generation)
            || (generation_column_count == generation_tables.len() && !has_winning_generation)
        {
            return Err("Knowledge database has an incomplete sync generation schema".into());
        }
        return Ok(if generation_column_count == generation_tables.len() {
            10
        } else {
            9
        });
    }
    if trigger_exists(connection, "positions_reject_pin_insert")
        .map_err(|error| error.to_string())?
    {
        return Ok(3);
    }
    Ok(2)
}

fn ensure_migration_history(connection: &Connection, detected_version: i64) -> Result<i64, String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS rollmap_schema_migrations (
                version INTEGER PRIMARY KEY NOT NULL,
                description TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('baseline', 'applied')),
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|error| error.to_string())?;

    for migration in GRAPH_MIGRATIONS
        .iter()
        .filter(|migration| migration.version <= detected_version)
    {
        connection
            .execute(
                "INSERT OR IGNORE INTO rollmap_schema_migrations (version, description, state)
                 VALUES (?1, ?2, 'baseline')",
                (migration.version, migration.description),
            )
            .map_err(|error| error.to_string())?;
    }

    let recorded_version = connection
        .query_row(
            "SELECT MAX(version) FROM rollmap_schema_migrations",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    if recorded_version > LATEST_GRAPH_SCHEMA_VERSION {
        return Err(format!(
            "Knowledge database schema {recorded_version} is newer than this app supports"
        ));
    }
    if recorded_version > detected_version {
        return Err("Knowledge database migration history does not match its schema".into());
    }
    Ok(recorded_version.max(detected_version))
}

fn create_backup(
    connection: &Connection,
    app_data_dir: &Path,
    filename: &str,
    current_version: i64,
) -> Result<(PathBuf, String), String> {
    let backup_directory = app_data_dir.join("migration-backups");
    fs::create_dir_all(&backup_directory).map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let backup_name = format!("{filename}-pre-v{current_version}-{timestamp}.db");
    let backup_path = backup_directory.join(&backup_name);
    let mut backup_connection =
        Connection::open(&backup_path).map_err(|error| error.to_string())?;
    let backup =
        Backup::new(connection, &mut backup_connection).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(64, Duration::from_millis(5), None)
        .map_err(|error| error.to_string())?;
    drop(backup);
    backup_connection
        .close()
        .map_err(|(_, error)| error.to_string())?;
    Ok((backup_path, format!("migration-backups/{backup_name}")))
}

pub fn prepare_graph_database(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<PreparedDatabase, String> {
    let filename = database_filename(database_url)?;
    fs::create_dir_all(app_data_dir).map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join(filename);
    let should_backup = database_path
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    let mut connection = Connection::open(&database_path).map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| error.to_string())?;
    let detected_version = detect_schema_version(&connection)?;
    let current_version = ensure_migration_history(&connection, detected_version)?;
    let pending_migrations: Vec<_> = GRAPH_MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current_version)
        .collect();
    if pending_migrations.is_empty() {
        return Ok(PreparedDatabase {
            schema_version: current_version,
            backup_relative_path: None,
        });
    }

    let backup = if should_backup {
        Some(create_backup(
            &connection,
            app_data_dir,
            filename,
            current_version,
        )?)
    } else {
        None
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for migration in pending_migrations {
        transaction
            .execute_batch(migration.sql)
            .map_err(|error| format!("Migration {} failed: {error}", migration.version))?;
        transaction
            .execute(
                "INSERT INTO rollmap_schema_migrations (version, description, state)
                 VALUES (?1, ?2, 'applied')",
                (migration.version, migration.description),
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let final_version = detect_schema_version(&connection)?;
    if final_version != LATEST_GRAPH_SCHEMA_VERSION {
        return Err(format!(
            "Knowledge database migration stopped at schema {final_version}"
        ));
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err(format!(
            "Knowledge database integrity check failed: {integrity}"
        ));
    }
    let has_foreign_key_violation = connection
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut statement| statement.exists([]))
        .map_err(|error| error.to_string())?;
    if has_foreign_key_violation {
        return Err("Knowledge database has foreign key violations after migration".into());
    }

    Ok(PreparedDatabase {
        schema_version: final_version,
        backup_relative_path: backup.map(|(_, relative_path)| relative_path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rollmap-storage-{name}-{}-{id}",
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

    #[test]
    fn prepares_a_new_database_at_the_latest_schema() {
        let directory = TestDirectory::new("new");
        let prepared =
            prepare_graph_database(&directory.0, "sqlite:library.db").expect("prepare database");
        assert_eq!(prepared.schema_version, 10);
        assert!(prepared.backup_relative_path.is_none());

        let connection = Connection::open(directory.0.join("library.db")).expect("open database");
        assert_eq!(
            detect_schema_version(&connection).expect("detect schema"),
            10
        );
        let migration_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM rollmap_schema_migrations",
                [],
                |row| row.get(0),
            )
            .expect("count migrations");
        assert_eq!(migration_count, 10);
        for table in [
            "sync_entity_versions",
            "sync_tombstones",
            "sync_journal",
            "sync_conflicts",
        ] {
            assert_eq!(
                column_not_null(&connection, table, "generation").expect("read generation column"),
                Some(true)
            );
        }
    }

    #[test]
    fn upgrades_legacy_data_and_creates_a_consistent_backup() {
        let directory = TestDirectory::new("legacy");
        let database_path = directory.0.join("legacy.db");
        let connection = Connection::open(&database_path).expect("open legacy database");
        connection
            .execute_batch(GRAPH_MIGRATIONS[0].sql)
            .expect("create legacy schema");
        connection
            .execute_batch(
                "INSERT INTO positions (id, name, category, role, side, x, y)
                 VALUES ('p1', 'Legacy Pin', 'pin', 'top', 'both', 0, 0);",
            )
            .expect("insert legacy data");
        drop(connection);

        let prepared =
            prepare_graph_database(&directory.0, "sqlite:legacy.db").expect("upgrade database");
        assert_eq!(prepared.schema_version, 10);
        let backup_relative_path = prepared.backup_relative_path.expect("backup path");
        let backup_path = directory.0.join(backup_relative_path);
        assert!(backup_path.is_file());

        let migrated = Connection::open(&database_path).expect("open migrated database");
        let category: String = migrated
            .query_row(
                "SELECT category FROM positions WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated data");
        assert_eq!(category, "control");
        assert!(column_not_null(&migrated, "positions", "side")
            .expect("read columns")
            .is_none());

        let backup = Connection::open(backup_path).expect("open backup");
        assert!(column_not_null(&backup, "positions", "side")
            .expect("read backup columns")
            .is_some());
    }

    #[test]
    fn baselines_an_existing_latest_schema_without_reapplying_migrations() {
        let directory = TestDirectory::new("baseline");
        let database_path = directory.0.join("existing.db");
        let connection = Connection::open(&database_path).expect("open existing database");
        for migration in GRAPH_MIGRATIONS {
            connection
                .execute_batch(migration.sql)
                .expect("apply existing migration");
        }
        drop(connection);

        let prepared =
            prepare_graph_database(&directory.0, "sqlite:existing.db").expect("baseline database");
        assert_eq!(prepared.schema_version, 10);
        assert!(prepared.backup_relative_path.is_none());
    }

    #[test]
    fn upgrades_v5_winners_with_their_journal_payloads() {
        let directory = TestDirectory::new("sync-v5");
        let database_path = directory.0.join("sync-v5.db");
        let connection = Connection::open(&database_path).expect("open v5 database");
        for migration in GRAPH_MIGRATIONS.iter().take(5) {
            connection
                .execute_batch(migration.sql)
                .expect("apply migration through v5");
        }
        connection
            .execute_batch(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0);
                 INSERT INTO sync_journal (
                    change_id, entity_type, entity_id, operation, hlc_physical_ms,
                    hlc_logical_counter, origin_device_id, payload_json
                 ) VALUES (
                    '104873f7-fe02-447c-bf16-1ad3b88d7087', 'position', 'p1',
                    'upsert', 1000, 0, '550e8400-e29b-41d4-a716-446655440000',
                    '{\"id\":\"p1\",\"name\":\"Guard\"}'
                 );
                 INSERT INTO sync_entity_versions (
                    entity_type, entity_id, hlc_physical_ms, hlc_logical_counter,
                    origin_device_id, is_deleted
                 ) VALUES (
                    'position', 'p1', 1000, 0,
                    '550e8400-e29b-41d4-a716-446655440000', 0
                 );",
            )
            .expect("seed v5 sync metadata");
        drop(connection);

        let prepared = prepare_graph_database(&directory.0, "sqlite:sync-v5.db")
            .expect("upgrade sync database");
        assert_eq!(prepared.schema_version, 10);
        assert!(prepared.backup_relative_path.is_some());

        let upgraded = Connection::open(database_path).expect("open upgraded database");
        let payload: String = upgraded
            .query_row(
                "SELECT payload_json FROM sync_entity_versions
                 WHERE entity_type = 'position' AND entity_id = 'p1'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled payload");
        assert_eq!(payload, "{\"id\":\"p1\",\"name\":\"Guard\"}");
        let winning_change_id: String = upgraded
            .query_row(
                "SELECT winning_change_id FROM sync_entity_versions
                 WHERE entity_type = 'position' AND entity_id = 'p1'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled winner change ID");
        assert_eq!(winning_change_id, "104873f7-fe02-447c-bf16-1ad3b88d7087");
        let journal_floor: String = upgraded
            .query_row(
                "SELECT value FROM sync_store_meta WHERE key = 'journal_floor'",
                [],
                |row| row.get(0),
            )
            .expect("read journal floor");
        assert_eq!(journal_floor, "0");
    }

    #[test]
    fn rejects_database_paths_outside_app_data() {
        let directory = TestDirectory::new("invalid");
        for database_url in [
            "file:rollmap.db",
            "sqlite:../rollmap.db",
            "sqlite:folder/rollmap.db",
            "sqlite:/tmp/rollmap.db",
            "sqlite:.hidden.db",
        ] {
            assert!(prepare_graph_database(&directory.0, database_url).is_err());
        }
    }

    #[test]
    fn rejects_migration_history_that_is_newer_than_the_actual_schema() {
        let directory = TestDirectory::new("history-mismatch");
        let database_path = directory.0.join("mismatch.db");
        let connection = Connection::open(database_path).expect("open database");
        connection
            .execute_batch(
                "CREATE TABLE rollmap_schema_migrations (
                    version INTEGER PRIMARY KEY NOT NULL,
                    description TEXT NOT NULL,
                    state TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO rollmap_schema_migrations (version, description, state)
                VALUES (4, 'allow_unknown_technique_target', 'applied');",
            )
            .expect("create mismatched history");
        drop(connection);

        let error = prepare_graph_database(&directory.0, "sqlite:mismatch.db")
            .expect_err("reject mismatched history");
        assert!(error.contains("history does not match"));
    }
}
