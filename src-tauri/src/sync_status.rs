use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOverview {
    trusted_peer_count: usize,
    pending_changes: usize,
    pending_snapshot_libraries: usize,
    missing_media_files: usize,
    missing_media_bytes: i64,
}

pub fn load_sync_overview(
    app_data_dir: &Path,
    active_sync_library_id: &str,
) -> Result<SyncOverview, String> {
    let catalog = crate::catalog::load_library_catalog(app_data_dir, None)?;
    let peers = crate::identity::list_trusted_peers(app_data_dir)?
        .into_iter()
        .filter(|peer| !peer.revoked)
        .collect::<Vec<_>>();
    let mut overview = SyncOverview {
        trusted_peer_count: peers.len(),
        ..SyncOverview::default()
    };

    for library in &catalog.libraries {
        let authorized_peer_ids = peers
            .iter()
            .filter(|peer| peer.sync_library_ids.contains(&library.sync_library_id))
            .map(|peer| peer.device_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let delivery = crate::sync_store::pending_sync_delivery(
            app_data_dir,
            &library.database_url,
            &authorized_peer_ids,
        )?;
        overview.pending_changes += delivery.pending_changes;
        overview.pending_snapshot_libraries += usize::from(delivery.requires_snapshot);
    }

    let active_library = catalog
        .libraries
        .iter()
        .find(|library| library.sync_library_id == active_sync_library_id)
        .ok_or("Active knowledge library was not found")?;
    let missing_media =
        crate::media_store::missing_media_blobs(app_data_dir, &active_library.database_url)?;
    overview.missing_media_files = missing_media.len();
    overview.missing_media_bytes = missing_media.iter().map(|blob| blob.byte_size).sum();
    Ok(overview)
}
