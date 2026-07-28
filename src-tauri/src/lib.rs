use reqwest::{redirect, Client, Url};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::Duration;
use tauri::{Emitter, Manager};

mod catalog;
mod discovery;
mod identity;
mod lan_sync;
mod media_preview;
mod media_store;
mod pairing_scanner;
mod storage;
mod sync_maintenance;
mod sync_protocol;
mod sync_status;
mod sync_store;
mod video_processor;

#[derive(Debug)]
struct BilibiliTarget {
    bvid: Option<String>,
    aid: Option<u64>,
    selected_page: u32,
    start_seconds: u64,
}

#[derive(Deserialize)]
struct BilibiliApiResponse {
    code: i32,
    message: String,
    data: Option<BilibiliApiData>,
}

#[derive(Deserialize)]
struct BilibiliApiData {
    bvid: String,
    title: String,
    duration: u64,
    owner: BilibiliApiOwner,
    pages: Vec<BilibiliApiPage>,
}

#[derive(Deserialize)]
struct BilibiliApiOwner {
    name: String,
}

#[derive(Deserialize)]
struct BilibiliApiPage {
    page: u32,
    cid: u64,
    part: String,
    duration: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BilibiliVideoInfo {
    bvid: String,
    title: String,
    owner: String,
    duration_seconds: u64,
    selected_page: u32,
    start_seconds: u64,
    pages: Vec<BilibiliPage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BilibiliPage {
    page: u32,
    cid: u64,
    part: String,
    duration_seconds: u64,
}

fn is_bilibili_host(url: &Url) -> bool {
    matches!(
        url.host_str().map(str::to_ascii_lowercase).as_deref(),
        Some(
            "api.bilibili.com"
                | "b23.tv"
                | "bilibili.com"
                | "m.bilibili.com"
                | "player.bilibili.com"
                | "www.bilibili.com"
        )
    )
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find_map(|(name, value)| (name == key).then(|| value.into_owned()))
}

fn parse_bilibili_target(url: &Url) -> Result<BilibiliTarget, String> {
    if url.scheme() != "https" || !is_bilibili_host(url) {
        return Err("Use an official HTTPS Bilibili link".into());
    }

    let video_identifier = url
        .path_segments()
        .and_then(|segments| {
            let segments = segments.collect::<Vec<_>>();
            segments
                .windows(2)
                .find(|window| window[0].eq_ignore_ascii_case("video"))
                .map(|window| window[1].to_string())
        })
        .or_else(|| query_value(url, "bvid"))
        .or_else(|| query_value(url, "aid"));
    let identifier = video_identifier.ok_or("The link does not contain a video ID")?;
    let (bvid, aid) = if identifier.len() == 12
        && identifier[..2].eq_ignore_ascii_case("bv")
        && identifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        (Some(format!("BV{}", &identifier[2..])), None)
    } else {
        let aid_value = identifier
            .strip_prefix("av")
            .or_else(|| identifier.strip_prefix("AV"))
            .unwrap_or(&identifier)
            .parse::<u64>()
            .map_err(|_| "The link contains an invalid video ID")?;
        (None, Some(aid_value))
    };
    let selected_page = query_value(url, "p")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let start_seconds = query_value(url, "t")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.floor() as u64)
        .unwrap_or(0);

    Ok(BilibiliTarget {
        bvid,
        aid,
        selected_page,
        start_seconds,
    })
}

fn bilibili_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Rollmap/0.1 Bilibili link inspector")
        .timeout(Duration::from_secs(10))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("Too many Bilibili redirects")
            } else if is_bilibili_host(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("Bilibili redirect left the official domains")
            }
        }))
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn inspect_bilibili_link(url: String) -> Result<BilibiliVideoInfo, String> {
    let source_url = Url::parse(url.trim()).map_err(|_| "Enter a valid Bilibili URL")?;
    if source_url.scheme() != "https" || !is_bilibili_host(&source_url) {
        return Err("Use an official HTTPS Bilibili link".into());
    }
    let client = bilibili_client()?;
    let (resolved_url, target) = match parse_bilibili_target(&source_url) {
        Ok(target) => (source_url, target),
        Err(_) => {
            let response = client
                .get(source_url)
                .send()
                .await
                .map_err(|error| format!("Could not resolve the Bilibili link: {error}"))?;
            if !response.status().is_success() {
                return Err("Bilibili could not resolve this link".into());
            }
            let resolved_url = response.url().clone();
            let target = parse_bilibili_target(&resolved_url)?;
            (resolved_url, target)
        }
    };
    if !is_bilibili_host(&resolved_url) {
        return Err("Bilibili redirect left the official domains".into());
    }

    let mut metadata_url = Url::parse("https://api.bilibili.com/x/web-interface/view")
        .map_err(|error| error.to_string())?;
    metadata_url.query_pairs_mut().append_pair(
        if target.bvid.is_some() { "bvid" } else { "aid" },
        target
            .bvid
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(|| target.aid.unwrap_or_default().to_string())
            .as_str(),
    );
    let response = client
        .get(metadata_url)
        .send()
        .await
        .map_err(|error| format!("Could not load Bilibili video details: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Bilibili video details failed: {error}"))?
        .json::<BilibiliApiResponse>()
        .await
        .map_err(|error| format!("Could not read Bilibili video details: {error}"))?;
    if response.code != 0 {
        return Err(if response.message.is_empty() {
            "Bilibili could not find this video".into()
        } else {
            response.message
        });
    }
    let data = response.data.ok_or("Bilibili returned no video details")?;
    if data.pages.is_empty() {
        return Err("Bilibili returned no playable video parts".into());
    }
    let selected_page = if data
        .pages
        .iter()
        .any(|page| page.page == target.selected_page)
    {
        target.selected_page
    } else {
        1
    };

    Ok(BilibiliVideoInfo {
        bvid: data.bvid,
        title: data.title,
        owner: data.owner.name,
        duration_seconds: data.duration,
        selected_page,
        start_seconds: target.start_seconds,
        pages: data
            .pages
            .into_iter()
            .map(|page| BilibiliPage {
                page: page.page,
                cid: page.cid,
                part: page.part,
                duration_seconds: page.duration,
            })
            .collect(),
    })
}

fn resolve_media_path(app_data_dir: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(value)) if value == "media")
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Video path must stay inside the app media directory".into());
    }
    Ok(app_data_dir.join(path))
}

#[tauri::command]
async fn process_video(
    app: tauri::AppHandle,
    operation_id: String,
    input_relative_path: String,
    output_relative_path: String,
    quality: String,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&operation_id).map_err(|_| "Invalid video processing operation")?;
    let preset = match quality.as_str() {
        "compact" => "Preset960x540",
        "balanced" => "PresetAppleM4V720pHD",
        "high" => "PresetAppleM4V1080pHD",
        "original" => "PresetPassthrough",
        _ => return Err("Unknown video quality".into()),
    };
    #[cfg(not(target_os = "macos"))]
    let _ = preset;
    if output_relative_path.rsplit('.').next() != Some("m4v") {
        return Err("Processed videos must use the m4v format".into());
    }
    if start_seconds.is_some_and(|value| !value.is_finite() || value < 0.0) {
        return Err("Invalid video clip start time".into());
    }
    if duration_seconds.is_some_and(|value| !value.is_finite() || value < 0.1) {
        return Err("Video clips must be at least 0.1 seconds long".into());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let input_path = resolve_media_path(&app_data_dir, &input_relative_path)?;
    let output_path = resolve_media_path(&app_data_dir, &output_relative_path)?;
    if !input_path.is_file() {
        return Err("The staged video file no longer exists".into());
    }
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "android")]
    {
        return video_processor::process_video(
            &app,
            &operation_id,
            &input_path,
            &output_path,
            &quality,
            start_seconds,
            duration_seconds,
        )
        .await;
    }

    #[cfg(not(target_os = "android"))]
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(not(target_os = "macos"))]
        return Err("Video processing is currently available on macOS".into());

        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/bin/avconvert");
            command
                .arg("--source")
                .arg(&input_path)
                .arg("--output")
                .arg(&output_path)
                .arg("--preset")
                .arg(preset)
                .arg("--replace");
            if let Some(start) = start_seconds {
                command.arg("--start").arg(format!("{start:.3}"));
            }
            if let Some(duration) = duration_seconds {
                command.arg("--duration").arg(format!("{duration:.3}"));
            }

            let output = command.output().map_err(|error| error.to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                let _ = std::fs::remove_file(&output_path);
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(if detail.is_empty() {
                    "macOS could not process this video format".into()
                } else {
                    detail
                })
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn cancel_video_processing(
    _app: tauri::AppHandle,
    operation_id: String,
) -> Result<bool, String> {
    uuid::Uuid::parse_str(&operation_id).map_err(|_| "Invalid video processing operation")?;

    #[cfg(target_os = "android")]
    return video_processor::cancel_video(&_app, &operation_id).await;

    #[cfg(not(target_os = "android"))]
    Err("Video processing cancellation is available on Android".into())
}

#[tauri::command]
async fn prepare_library_database(
    app: tauri::AppHandle,
    database_url: String,
) -> Result<storage::PreparedDatabase, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        media_store::index_legacy_media(&app_data_dir, &database_url, &device_id)?;
        Ok(prepared)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn ingest_media_blob(
    app: tauri::AppHandle,
    database_url: String,
    relative_path: String,
) -> Result<media_store::MediaBlob, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        media_store::ingest_media_blob(&app_data_dir, &database_url, &relative_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn collect_media_garbage(
    app: tauri::AppHandle,
    dry_run: bool,
) -> Result<media_store::MediaGarbageCollectionReport, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        media_store::collect_media_garbage(&app_data_dir, dry_run)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedMediaFile {
    byte_size: u64,
    file_name: Option<String>,
}

#[tauri::command]
async fn stage_media_file(
    app: tauri::AppHandle,
    source_uri: String,
    destination_relative_path: String,
    media_kind: String,
) -> Result<StagedMediaFile, String> {
    if !source_uri.starts_with("content://") {
        return Err("Android media staging requires a content URI".into());
    }
    let (maximum_bytes, size_error) = match media_kind.as_str() {
        "image" => (100 * 1024 * 1024, "Image exceeds 100 MB"),
        "video" => (4 * 1024 * 1024 * 1024, "Video exceeds 4 GB"),
        _ => return Err("Unknown media type".into()),
    };
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let destination_path = resolve_media_path(&app_data_dir, &destination_relative_path)?;

    #[cfg(target_os = "android")]
    let source_file_name = app.path().file_name(&source_uri);

    #[cfg(target_os = "android")]
    return tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};
        use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

        let source = source_uri
            .parse::<FilePath>()
            .map_err(|error| error.to_string())?;
        let mut options = OpenOptions::new();
        options.read(true);
        let mut input = app
            .fs()
            .open(source, options)
            .map_err(|error| error.to_string())?;
        if let Some(parent) = destination_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let result = (|| {
            let mut output =
                std::fs::File::create(&destination_path).map_err(|error| error.to_string())?;
            let mut limited_input = Read::take(&mut input, maximum_bytes + 1);
            let copied = std::io::copy(&mut limited_input, &mut output)
                .map_err(|error| error.to_string())?;
            if copied > maximum_bytes {
                return Err(size_error.to_string());
            }
            output.flush().map_err(|error| error.to_string())?;
            Ok(StagedMediaFile {
                byte_size: copied,
                file_name: source_file_name,
            })
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&destination_path);
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?;

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, destination_path, maximum_bytes, size_error);
        Err("Android media staging is available only on Android".into())
    }
}

#[tauri::command]
async fn download_media_blob(
    app: tauri::AppHandle,
    sync_library_id: String,
    blob_hash: String,
) -> Result<media_store::MediaBlob, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    lan_sync::download_media_blob(app_data_dir, sync_library_id, blob_hash).await
}

#[tauri::command]
async fn download_library_media(
    app: tauri::AppHandle,
    manager: tauri::State<'_, lan_sync::MediaTransferManager>,
    sync_library_id: String,
    transfer_id: String,
) -> Result<lan_sync::MediaTransferReport, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let progress_app = app.clone();
    lan_sync::download_library_media(
        app_data_dir,
        sync_library_id,
        transfer_id,
        &manager,
        move |progress| {
            let _ = progress_app.emit("media-transfer-progress", progress);
        },
    )
    .await
}

#[tauri::command]
fn cancel_media_transfer(
    manager: tauri::State<'_, lan_sync::MediaTransferManager>,
    transfer_id: String,
) -> Result<bool, String> {
    manager.cancel(&transfer_id)
}

#[tauri::command]
async fn apply_graph_mutation(
    app: tauri::AppHandle,
    database_url: String,
    mutation: sync_store::GraphMutation,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        sync_store::apply_graph_mutation(&app_data_dir, &database_url, &device_id, mutation)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_sync_changes(
    app: tauri::AppHandle,
    database_url: String,
    after_sequence: i64,
    limit: u32,
) -> Result<sync_store::SyncBatch, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        sync_store::read_sync_changes(&app_data_dir, &database_url, after_sequence, limit)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_sync_snapshot(
    app: tauri::AppHandle,
    database_url: String,
) -> Result<sync_store::SyncSnapshot, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        sync_store::read_sync_snapshot(&app_data_dir, &database_url)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn apply_sync_snapshot(
    app: tauri::AppHandle,
    database_url: String,
    peer_device_id: String,
    snapshot: sync_store::SyncSnapshot,
) -> Result<sync_store::SyncMergeResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        sync_store::apply_sync_snapshot(&app_data_dir, &database_url, &peer_device_id, snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn update_sync_peer_cursor(
    app: tauri::AppHandle,
    database_url: String,
    peer_device_id: String,
    cursor_kind: sync_store::PeerCursorKind,
    sequence: i64,
) -> Result<i64, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        sync_store::update_peer_cursor(
            &app_data_dir,
            &database_url,
            &peer_device_id,
            cursor_kind,
            sequence,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn compact_sync_journal(
    app: tauri::AppHandle,
    database_url: String,
) -> Result<sync_store::SyncCompactionResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        sync_maintenance::compact_sync_journal(&app_data_dir, &database_url)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn merge_sync_changes(
    app: tauri::AppHandle,
    database_url: String,
    changes: Vec<sync_store::SyncChange>,
) -> Result<sync_store::SyncMergeResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let device_id = catalog::local_device_id(&app_data_dir)?;
        sync_store::bootstrap_database(&app_data_dir, &database_url, &device_id)?;
        sync_store::merge_sync_changes(&app_data_dir, &database_url, changes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_library_catalog(
    app: tauri::AppHandle,
    legacy_catalog: Option<catalog::LegacyLibraryCatalog>,
) -> Result<catalog::LibraryCatalog, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog::load_library_catalog(&app_data_dir, legacy_catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_library_catalog(
    app: tauri::AppHandle,
    catalog: catalog::LibraryCatalog,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog::save_library_catalog(&app_data_dir, catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_device_identity(app: tauri::AppHandle) -> Result<identity::DeviceIdentity, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || identity::device_identity(&app_data_dir))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_pairing_offer(
    app: tauri::AppHandle,
    display_name: String,
) -> Result<identity::PairingOffer, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::create_pairing_offer(&app_data_dir, &display_name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_pairing_request(
    app: tauri::AppHandle,
    offer: identity::PairingOffer,
    peer_display_name: String,
    sync_library_ids: Vec<String>,
) -> Result<identity::PairingRequest, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::create_pairing_request(&app_data_dir, offer, &peer_display_name, sync_library_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn complete_pairing(
    app: tauri::AppHandle,
    request: identity::PairingRequest,
) -> Result<identity::TrustedPeer, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || identity::complete_pairing(&app_data_dir, request))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn trust_pairing_offer(
    app: tauri::AppHandle,
    offer: identity::PairingOffer,
    sync_library_ids: Vec<String>,
) -> Result<identity::TrustedPeer, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::trust_pairing_offer(&app_data_dir, offer, sync_library_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_trusted_peers(app: tauri::AppHandle) -> Result<Vec<identity::TrustedPeer>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || identity::list_trusted_peers(&app_data_dir))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn rename_trusted_peer(
    app: tauri::AppHandle,
    peer_device_id: String,
    display_name: String,
) -> Result<identity::TrustedPeer, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::rename_trusted_peer(&app_data_dir, &peer_device_id, &display_name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn revoke_trusted_peer(
    app: tauri::AppHandle,
    peer_device_id: String,
) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::revoke_trusted_peer(&app_data_dir, &peer_device_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn generate_authentication_challenge() -> String {
    identity::generate_authentication_challenge()
}

#[tauri::command]
async fn sign_authentication_challenge(
    app: tauri::AppHandle,
    challenge: String,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::sign_authentication_challenge(&app_data_dir, &challenge)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn verify_trusted_peer_signature(
    app: tauri::AppHandle,
    peer_device_id: String,
    challenge: String,
    signature: String,
) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        identity::verify_trusted_peer_signature(
            &app_data_dir,
            &peer_device_id,
            &challenge,
            &signature,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_lan_sync_server(
    app: tauri::AppHandle,
    manager: tauri::State<'_, lan_sync::LanServerManager>,
) -> Result<lan_sync::LanServerInfo, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    manager.start(app_data_dir).await
}

#[tauri::command]
async fn get_lan_sync_server_status(
    manager: tauri::State<'_, lan_sync::LanServerManager>,
) -> Result<Option<lan_sync::LanServerInfo>, String> {
    Ok(manager.status().await)
}

#[tauri::command]
async fn list_discovered_lan_peers(
    manager: tauri::State<'_, lan_sync::LanServerManager>,
) -> Result<Vec<discovery::DiscoveredLanPeer>, String> {
    Ok(manager.discovered_peers().await)
}

#[tauri::command]
async fn stop_lan_sync_server(
    manager: tauri::State<'_, lan_sync::LanServerManager>,
) -> Result<bool, String> {
    manager.stop().await
}

#[tauri::command]
async fn pair_with_lan_server(
    app: tauri::AppHandle,
    base_url: String,
    offer: identity::PairingOffer,
    peer_display_name: String,
    sync_library_ids: Vec<String>,
) -> Result<identity::TrustedPeer, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    lan_sync::pair_with_server(
        app_data_dir,
        base_url,
        offer,
        peer_display_name,
        sync_library_ids,
    )
    .await
}

#[tauri::command]
async fn sync_with_lan_server(
    app: tauri::AppHandle,
    base_url: String,
    remote_device_id: String,
) -> Result<lan_sync::LanSyncReport, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    lan_sync::sync_with_server(app_data_dir, base_url, remote_device_id).await
}

#[tauri::command]
async fn scan_pairing_qr(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    return pairing_scanner::scan(&_app).await;

    #[cfg(not(target_os = "android"))]
    Err("Pairing QR scanning is available on Android".into())
}

#[tauri::command]
async fn get_sync_overview(
    app: tauri::AppHandle,
    active_sync_library_id: String,
) -> Result<sync_status::SyncOverview, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        sync_status::load_sync_overview(&app_data_dir, &active_sync_library_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn resolve_media_preview_url(
    app: tauri::AppHandle,
    manager: tauri::State<'_, media_preview::MediaPreviewServerManager>,
    relative_path: String,
) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    manager.preview_url(app_data_dir, relative_path).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lan_sync::LanServerManager::default())
        .manage(lan_sync::MediaTransferManager::default())
        .manage(media_preview::MediaPreviewServerManager::default())
        .plugin(pairing_scanner::init())
        .plugin(video_processor::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            inspect_bilibili_link,
            process_video,
            cancel_video_processing,
            ingest_media_blob,
            collect_media_garbage,
            stage_media_file,
            download_media_blob,
            download_library_media,
            cancel_media_transfer,
            prepare_library_database,
            apply_graph_mutation,
            read_sync_changes,
            read_sync_snapshot,
            apply_sync_snapshot,
            update_sync_peer_cursor,
            compact_sync_journal,
            merge_sync_changes,
            load_library_catalog,
            save_library_catalog,
            get_device_identity,
            create_pairing_offer,
            create_pairing_request,
            complete_pairing,
            trust_pairing_offer,
            list_trusted_peers,
            rename_trusted_peer,
            revoke_trusted_peer,
            generate_authentication_challenge,
            sign_authentication_challenge,
            verify_trusted_peer_signature,
            start_lan_sync_server,
            get_lan_sync_server_status,
            list_discovered_lan_peers,
            stop_lan_sync_server,
            pair_with_lan_server,
            sync_with_lan_server,
            scan_pairing_qr,
            get_sync_overview,
            resolve_media_preview_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_bilibili_targets() {
        let url =
            Url::parse("https://www.bilibili.com/video/BV1B7411m7LV/?p=3&t=83.9&spm_id_from=x")
                .unwrap();
        let target = parse_bilibili_target(&url).unwrap();
        assert_eq!(target.bvid.as_deref(), Some("BV1B7411m7LV"));
        assert_eq!(target.selected_page, 3);
        assert_eq!(target.start_seconds, 83);
    }

    #[test]
    fn rejects_non_bilibili_and_insecure_urls() {
        assert!(parse_bilibili_target(
            &Url::parse("https://example.com/video/BV1B7411m7LV").unwrap()
        )
        .is_err());
        assert!(parse_bilibili_target(
            &Url::parse("http://www.bilibili.com/video/BV1B7411m7LV").unwrap()
        )
        .is_err());
    }

    #[test]
    #[ignore = "requires the public Bilibili service"]
    fn inspects_an_official_bilibili_short_link() {
        let info = tauri::async_runtime::block_on(inspect_bilibili_link(
            "https://b23.tv/BV1B7411m7LV".into(),
        ))
        .unwrap();
        assert_eq!(info.bvid, "BV1B7411m7LV");
        assert!(!info.title.is_empty());
        assert!(!info.pages.is_empty());
    }
}
