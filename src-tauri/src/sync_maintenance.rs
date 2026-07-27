use std::path::Path;

pub fn compact_sync_journal(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<crate::sync_store::SyncCompactionResult, String> {
    crate::storage::prepare_graph_database(app_data_dir, database_url)?;
    let device_id = crate::catalog::local_device_id(app_data_dir)?;
    crate::sync_store::bootstrap_database(app_data_dir, database_url, &device_id)?;
    compact_prepared_sync_journal(app_data_dir, database_url)
}

pub fn compact_prepared_sync_journal(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<crate::sync_store::SyncCompactionResult, String> {
    let required_peer_ids = crate::catalog::required_sync_peer_ids(app_data_dir, database_url)?;
    crate::sync_store::compact_sync_journal(app_data_dir, database_url, &required_peer_ids)
}

pub fn compact_prepared_sync_journal_best_effort(app_data_dir: &Path, database_url: &str) {
    if compact_prepared_sync_journal(app_data_dir, database_url).is_err() {
        eprintln!("Automatic sync-journal compaction failed; it will be retried later");
    }
}

pub fn compact_all_existing_sync_journals_best_effort(app_data_dir: &Path) {
    let Ok(catalog) = crate::catalog::load_library_catalog(app_data_dir, None) else {
        eprintln!("Automatic sync-journal maintenance could not read the library catalog");
        return;
    };
    for library in catalog.libraries {
        let Ok(filename) = crate::storage::database_filename(&library.database_url) else {
            eprintln!("Automatic sync-journal maintenance skipped an invalid database entry");
            continue;
        };
        if !app_data_dir.join(filename).is_file() {
            continue;
        }
        if compact_sync_journal(app_data_dir, &library.database_url).is_err() {
            eprintln!("Automatic sync-journal compaction failed; it will be retried later");
        }
    }
}
