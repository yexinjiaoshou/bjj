use serde::{Deserialize, Serialize};
use std::path::Path;

pub const PROTOCOL_MAJOR: u32 = 2;
pub const MAX_BATCH_CHANGES: u32 = 500;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolCapabilities {
    incremental_sync: bool,
    snapshot_sync: bool,
    catalog_sync: bool,
    media_sync: bool,
    max_batch_changes: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolHello {
    pub(crate) protocol_major: u32,
    pub(crate) app_version: String,
    pub(crate) device: crate::identity::DeviceIdentity,
    pub(crate) capabilities: ProtocolCapabilities,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullChangesRequest {
    pub protocol_major: u32,
    pub sync_library_id: String,
    pub after_sequence: i64,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshotRequest {
    pub protocol_major: u32,
    pub sync_library_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushChangesRequest {
    pub protocol_major: u32,
    pub sync_library_id: String,
    pub changes: Vec<crate::sync_store::SyncChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSnapshotRequest {
    pub protocol_major: u32,
    pub sync_library_id: String,
    pub snapshot: crate::sync_store::SyncSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeRequest {
    pub protocol_major: u32,
    pub sync_library_id: String,
    pub sequence: i64,
}

fn validate_protocol_major(protocol_major: u32) -> Result<(), String> {
    if protocol_major != PROTOCOL_MAJOR {
        return Err(format!(
            "Sync protocol major {protocol_major} is not supported; expected {PROTOCOL_MAJOR}"
        ));
    }
    Ok(())
}

fn prepare_authorized_database(
    app_data_dir: &Path,
    peer_device_id: &str,
    sync_library_id: &str,
) -> Result<String, String> {
    let database_url = crate::catalog::authorized_library_database_url(
        app_data_dir,
        peer_device_id,
        sync_library_id,
    )?;
    crate::storage::prepare_graph_database(app_data_dir, &database_url)?;
    let local_device_id = crate::catalog::local_device_id(app_data_dir)?;
    crate::sync_store::bootstrap_database(app_data_dir, &database_url, &local_device_id)?;
    Ok(database_url)
}

pub fn hello(app_data_dir: &Path) -> Result<ProtocolHello, String> {
    Ok(ProtocolHello {
        protocol_major: PROTOCOL_MAJOR,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        device: crate::identity::device_identity(app_data_dir)?,
        capabilities: ProtocolCapabilities {
            incremental_sync: true,
            snapshot_sync: true,
            catalog_sync: true,
            media_sync: true,
            max_batch_changes: MAX_BATCH_CHANGES,
        },
    })
}

pub fn pull_changes(
    app_data_dir: &Path,
    peer_device_id: &str,
    request: PullChangesRequest,
) -> Result<crate::sync_store::SyncBatch, String> {
    validate_protocol_major(request.protocol_major)?;
    let database_url =
        prepare_authorized_database(app_data_dir, peer_device_id, &request.sync_library_id)?;
    crate::sync_store::read_sync_changes(
        app_data_dir,
        &database_url,
        request.after_sequence,
        request.limit,
    )
}

pub fn pull_snapshot(
    app_data_dir: &Path,
    peer_device_id: &str,
    request: LibrarySnapshotRequest,
) -> Result<crate::sync_store::SyncSnapshot, String> {
    validate_protocol_major(request.protocol_major)?;
    let database_url =
        prepare_authorized_database(app_data_dir, peer_device_id, &request.sync_library_id)?;
    crate::sync_store::read_sync_snapshot(app_data_dir, &database_url)
}

pub fn push_changes(
    app_data_dir: &Path,
    peer_device_id: &str,
    request: PushChangesRequest,
) -> Result<crate::sync_store::SyncMergeResult, String> {
    validate_protocol_major(request.protocol_major)?;
    if request.changes.len() > MAX_BATCH_CHANGES as usize {
        return Err(format!(
            "Sync batch cannot contain more than {MAX_BATCH_CHANGES} changes"
        ));
    }
    let database_url =
        prepare_authorized_database(app_data_dir, peer_device_id, &request.sync_library_id)?;
    crate::sync_store::merge_sync_changes_from_peer(
        app_data_dir,
        &database_url,
        peer_device_id,
        request.changes,
    )
}

pub fn push_snapshot(
    app_data_dir: &Path,
    peer_device_id: &str,
    request: PushSnapshotRequest,
) -> Result<crate::sync_store::SyncMergeResult, String> {
    validate_protocol_major(request.protocol_major)?;
    let database_url =
        prepare_authorized_database(app_data_dir, peer_device_id, &request.sync_library_id)?;
    crate::sync_store::apply_sync_snapshot(
        app_data_dir,
        &database_url,
        peer_device_id,
        request.snapshot,
    )
}

pub fn acknowledge(
    app_data_dir: &Path,
    peer_device_id: &str,
    request: AcknowledgeRequest,
) -> Result<i64, String> {
    validate_protocol_major(request.protocol_major)?;
    let database_url =
        prepare_authorized_database(app_data_dir, peer_device_id, &request.sync_library_id)?;
    let acknowledged = crate::sync_store::update_peer_cursor(
        app_data_dir,
        &database_url,
        peer_device_id,
        crate::sync_store::PeerCursorKind::Acknowledged,
        request.sequence,
    )?;
    crate::sync_maintenance::compact_prepared_sync_journal_best_effort(app_data_dir, &database_url);
    Ok(acknowledged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);
    const SOURCE_DEVICE_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const TARGET_DEVICE_ID: &str = "7b2cd5dc-c12c-43f6-86f6-4e3b51b0dc49";
    const THIRD_DEVICE_ID: &str = "84ef9237-307d-45c7-b5c2-121d5e24bc3f";

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rollmap-protocol-{name}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn graph_connection(&self, database_url: &str) -> Connection {
            let filename =
                crate::storage::database_filename(database_url).expect("read database filename");
            Connection::open(self.0.join(filename)).expect("open graph database")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn set_device_id(directory: &TestDirectory, device_id: &str) {
        let connection = crate::catalog::open_catalog(&directory.0).expect("open catalog");
        connection
            .execute(
                "INSERT INTO catalog_meta (key, value) VALUES ('local_device_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [device_id],
            )
            .expect("set device identity");
    }

    fn default_library(directory: &TestDirectory) -> (String, String) {
        crate::catalog::load_library_catalog(&directory.0, None).expect("load catalog");
        let connection = crate::catalog::open_catalog(&directory.0).expect("open catalog");
        connection
            .query_row(
                "SELECT sync_library_id, database_url FROM libraries WHERE id = 'default'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read default library")
    }

    fn add_replica_library(directory: &TestDirectory, sync_library_id: &str) -> String {
        crate::catalog::load_library_catalog(&directory.0, None).expect("load catalog");
        let database_url = format!("sqlite:rollmap-library-{sync_library_id}.db");
        crate::catalog::open_catalog(&directory.0)
            .expect("open catalog")
            .execute(
                "INSERT INTO libraries (
                    id, sync_library_id, name, database_url,
                    media_directory, browser_storage_key
                 ) VALUES (?1, ?1, 'Replica', ?2, ?3, ?4)",
                params![
                    sync_library_id,
                    database_url,
                    format!("media/{sync_library_id}"),
                    format!("rollmap.graph.library.{sync_library_id}"),
                ],
            )
            .expect("insert replica library");
        database_url
    }

    fn authorize_peer(
        directory: &TestDirectory,
        peer_device_id: &str,
        sync_library_id: &str,
        key_byte: u8,
    ) {
        let connection = crate::catalog::open_catalog(&directory.0).expect("open catalog");
        connection
            .execute(
                "INSERT INTO trusted_peers (
                    device_id, display_name, identity_public_key
                 ) VALUES (?1, 'Test peer', ?2)",
                params![peer_device_id, vec![key_byte; 32]],
            )
            .expect("insert trusted peer");
        connection
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 VALUES (?1, ?2)",
                params![peer_device_id, sync_library_id],
            )
            .expect("authorize peer library");
    }

    #[test]
    fn acknowledgements_compact_only_through_every_authorized_peer() {
        let source = TestDirectory::new("automatic-compaction");
        let (sync_library_id, database_url) = default_library(&source);
        set_device_id(&source, SOURCE_DEVICE_ID);
        authorize_peer(&source, TARGET_DEVICE_ID, &sync_library_id, 2);
        authorize_peer(&source, THIRD_DEVICE_ID, &sync_library_id, 3);
        crate::storage::prepare_graph_database(&source.0, &database_url)
            .expect("prepare source graph");
        source
            .graph_connection(&database_url)
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("seed source graph");
        crate::sync_store::bootstrap_database(&source.0, &database_url, SOURCE_DEVICE_ID)
            .expect("bootstrap source graph");

        let acknowledge_to = |peer_device_id: &str, sequence| {
            acknowledge(
                &source.0,
                peer_device_id,
                AcknowledgeRequest {
                    protocol_major: PROTOCOL_MAJOR,
                    sync_library_id: sync_library_id.clone(),
                    sequence,
                },
            )
            .expect("acknowledge source changes")
        };
        let journal_state = || {
            source
                .graph_connection(&database_url)
                .query_row(
                    "SELECT
                        (SELECT CAST(value AS INTEGER) FROM sync_store_meta
                         WHERE key = 'journal_floor'),
                        (SELECT COUNT(*) FROM sync_journal)",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .expect("read journal state")
        };

        assert_eq!(acknowledge_to(TARGET_DEVICE_ID, 2), 2);
        assert_eq!(journal_state(), (0, 2));

        assert_eq!(acknowledge_to(THIRD_DEVICE_ID, 1), 1);
        assert_eq!(journal_state(), (1, 1));

        assert_eq!(acknowledge_to(THIRD_DEVICE_ID, 2), 2);
        assert_eq!(journal_state(), (2, 0));
    }

    #[test]
    fn routes_authorized_incremental_sync_by_library_identity() {
        let source = TestDirectory::new("source");
        let target = TestDirectory::new("target");
        let (sync_library_id, source_database_url) = default_library(&source);
        set_device_id(&source, SOURCE_DEVICE_ID);
        authorize_peer(&source, TARGET_DEVICE_ID, &sync_library_id, 2);
        crate::storage::prepare_graph_database(&source.0, &source_database_url)
            .expect("prepare source graph");
        source
            .graph_connection(&source_database_url)
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("seed source graph");
        crate::sync_store::bootstrap_database(&source.0, &source_database_url, SOURCE_DEVICE_ID)
            .expect("bootstrap source graph");

        let hello = hello(&source.0).expect("read protocol hello");
        assert_eq!(hello.protocol_major, PROTOCOL_MAJOR);
        assert_eq!(hello.device.device_id, SOURCE_DEVICE_ID);
        let batch = pull_changes(
            &source.0,
            TARGET_DEVICE_ID,
            PullChangesRequest {
                protocol_major: PROTOCOL_MAJOR,
                sync_library_id: sync_library_id.clone(),
                after_sequence: 0,
                limit: MAX_BATCH_CHANGES,
            },
        )
        .expect("pull source changes");
        assert_eq!(batch.changes.len(), 2);

        default_library(&target);
        set_device_id(&target, TARGET_DEVICE_ID);
        let target_database_url = add_replica_library(&target, &sync_library_id);
        authorize_peer(&target, SOURCE_DEVICE_ID, &sync_library_id, 1);
        let merged = push_changes(
            &target.0,
            SOURCE_DEVICE_ID,
            PushChangesRequest {
                protocol_major: PROTOCOL_MAJOR,
                sync_library_id: sync_library_id.clone(),
                changes: batch.changes,
            },
        )
        .expect("push changes into target");
        assert_eq!(merged.applied, 2);
        let position_name: String = target
            .graph_connection(&target_database_url)
            .query_row("SELECT name FROM positions WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .expect("read target position");
        assert_eq!(position_name, "Guard");
        assert_eq!(
            crate::sync_store::read_peer_cursor(
                &target.0,
                &target_database_url,
                SOURCE_DEVICE_ID,
                crate::sync_store::PeerCursorKind::Pulled,
            )
            .expect("read target pulled cursor"),
            2
        );

        let acknowledged = acknowledge(
            &source.0,
            TARGET_DEVICE_ID,
            AcknowledgeRequest {
                protocol_major: PROTOCOL_MAJOR,
                sync_library_id: sync_library_id.clone(),
                sequence: 2,
            },
        )
        .expect("acknowledge source changes");
        assert_eq!(acknowledged, 2);
        assert_eq!(
            crate::catalog::authorized_sync_libraries(&source.0, TARGET_DEVICE_ID)
                .expect("list authorized source libraries"),
            vec![crate::catalog::AuthorizedSyncLibrary {
                sync_library_id: sync_library_id.clone(),
                database_url: source_database_url,
            }]
        );

        let unauthorized_library_id = "84ef9237-307d-45c7-b5c2-121d5e24bc3f";
        assert!(pull_snapshot(
            &source.0,
            TARGET_DEVICE_ID,
            LibrarySnapshotRequest {
                protocol_major: PROTOCOL_MAJOR,
                sync_library_id: unauthorized_library_id.into(),
            },
        )
        .expect_err("reject unauthorized library")
        .contains("not authorized"));
        assert!(pull_changes(
            &source.0,
            TARGET_DEVICE_ID,
            PullChangesRequest {
                protocol_major: 99,
                sync_library_id,
                after_sequence: 0,
                limit: 1,
            },
        )
        .expect_err("reject incompatible protocol")
        .contains("not supported"));
    }
}
