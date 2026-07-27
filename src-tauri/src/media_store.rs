use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const MEDIA_BLOB_ROOT: &str = "media/blobs/sha256";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaBlob {
    pub blob_hash: String,
    pub relative_path: String,
    pub mime_type: String,
    pub file_extension: String,
    pub byte_size: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaGarbageCollectionReport {
    pub dry_run: bool,
    pub libraries_scanned: usize,
    pub referenced_blobs: usize,
    pub reclaimable_files: usize,
    pub reclaimable_partial_files: usize,
    pub reclaimable_bytes: u64,
    pub stale_records: usize,
    pub removed_files: usize,
    pub removed_partial_files: usize,
    pub removed_bytes: u64,
    pub removed_records: usize,
}

struct ReclaimableMediaFile {
    path: PathBuf,
    byte_size: u64,
    partial: bool,
}

fn database_path(app_data_dir: &Path, database_url: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir.join(crate::storage::database_filename(database_url)?))
}

fn validated_relative_path(relative_path: &str) -> Result<&Path, String> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Media path must stay inside app data".into());
    }
    Ok(path)
}

fn extension_and_mime(relative_path: &Path) -> Result<(String, String), String> {
    let extension = relative_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Media file is missing an extension".to_string())?;
    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        _ => return Err("Unsupported media file type".into()),
    };
    Ok((extension, mime_type.into()))
}

fn hash_file(path: &Path) -> Result<(String, i64), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let byte_size = i64::try_from(file.metadata().map_err(|error| error.to_string())?.len())
        .map_err(|_| "Media file is too large".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let blob_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((blob_hash, byte_size))
}

fn blob_relative_path(blob_hash: &str, extension: &str) -> String {
    format!(
        "media/blobs/sha256/{}/{}.{}",
        &blob_hash[..2],
        blob_hash,
        extension
    )
}

fn validate_blob_hash(blob_hash: &str) -> Result<(), String> {
    if blob_hash.len() != 64
        || !blob_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Media hash must be a lowercase SHA-256 hexadecimal value".into());
    }
    Ok(())
}

fn referenced_blob_hashes(connection: &Connection) -> Result<BTreeSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT blob_hash FROM attachments
             WHERE kind IN ('image', 'video') AND blob_hash IS NOT NULL
             ORDER BY blob_hash",
        )
        .map_err(|error| error.to_string())?;
    let hashes = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    for hash in &hashes {
        validate_blob_hash(hash)?;
    }
    Ok(hashes)
}

fn stale_blob_records(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT media_blobs.blob_hash
             FROM media_blobs
             WHERE NOT EXISTS (
                 SELECT 1 FROM attachments
                 WHERE attachments.blob_hash = media_blobs.blob_hash
             )
             ORDER BY media_blobs.blob_hash",
        )
        .map_err(|error| error.to_string())?;
    let hashes = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for hash in &hashes {
        validate_blob_hash(hash)?;
    }
    Ok(hashes)
}

fn pooled_media_file(prefix: &str, file_name: &str) -> Option<(String, bool)> {
    let (media_name, partial) = file_name
        .strip_suffix(".part")
        .map_or((file_name, false), |name| (name, true));
    let (blob_hash, _) = media_name.split_once('.')?;
    validate_blob_hash(blob_hash).ok()?;
    if prefix != &blob_hash[..2] || extension_and_mime(Path::new(media_name)).is_err() {
        return None;
    }
    Some((blob_hash.to_string(), partial))
}

fn reclaimable_media_files(
    app_data_dir: &Path,
    referenced_blobs: &BTreeSet<String>,
) -> Result<Vec<ReclaimableMediaFile>, String> {
    let root = app_data_dir.join(MEDIA_BLOB_ROOT);
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err("Media content pool is not a directory".into());
    }

    let mut files = Vec::new();
    for prefix_entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let prefix_entry = prefix_entry.map_err(|error| error.to_string())?;
        if !prefix_entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let Some(prefix) = prefix_entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        for file_entry in fs::read_dir(prefix_entry.path()).map_err(|error| error.to_string())? {
            let file_entry = file_entry.map_err(|error| error.to_string())?;
            if !file_entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                continue;
            }
            let Some(file_name) = file_entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some((blob_hash, partial)) = pooled_media_file(&prefix, &file_name) else {
                continue;
            };
            if referenced_blobs.contains(&blob_hash) {
                continue;
            }
            let byte_size = file_entry
                .metadata()
                .map_err(|error| error.to_string())?
                .len();
            files.push(ReclaimableMediaFile {
                path: file_entry.path(),
                byte_size,
                partial,
            });
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn collect_media_garbage(
    app_data_dir: &Path,
    dry_run: bool,
) -> Result<MediaGarbageCollectionReport, String> {
    let catalog = crate::catalog::load_library_catalog(app_data_dir, None)?;
    let mut connections = Vec::with_capacity(catalog.libraries.len());
    for library in &catalog.libraries {
        let path = database_path(app_data_dir, &library.database_url)?;
        if !path.is_file() {
            return Err(format!(
                "Knowledge database for '{}' does not exist",
                library.name
            ));
        }
        crate::storage::prepare_graph_database(app_data_dir, &library.database_url)?;
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        if !dry_run {
            connection
                .execute_batch("BEGIN IMMEDIATE")
                .map_err(|error| error.to_string())?;
        }
        connections.push(connection);
    }

    let mut referenced_blobs = BTreeSet::new();
    let mut stale_records = Vec::with_capacity(connections.len());
    for connection in &connections {
        referenced_blobs.extend(referenced_blob_hashes(connection)?);
        stale_records.push(stale_blob_records(connection)?);
    }
    let reclaimable_files = reclaimable_media_files(app_data_dir, &referenced_blobs)?;
    let mut report = MediaGarbageCollectionReport {
        dry_run,
        libraries_scanned: connections.len(),
        referenced_blobs: referenced_blobs.len(),
        reclaimable_files: reclaimable_files.len(),
        reclaimable_partial_files: reclaimable_files.iter().filter(|file| file.partial).count(),
        reclaimable_bytes: reclaimable_files.iter().map(|file| file.byte_size).sum(),
        stale_records: stale_records.iter().map(Vec::len).sum(),
        ..MediaGarbageCollectionReport::default()
    };
    if dry_run {
        return Ok(report);
    }

    for file in reclaimable_files {
        fs::remove_file(&file.path).map_err(|error| {
            format!(
                "Could not remove media file {}: {error}",
                file.path.display()
            )
        })?;
        report.removed_files += 1;
        report.removed_bytes += file.byte_size;
        if file.partial {
            report.removed_partial_files += 1;
        }
    }
    for (connection, hashes) in connections.iter().zip(&stale_records) {
        for hash in hashes {
            report.removed_records += connection
                .execute("DELETE FROM media_blobs WHERE blob_hash = ?1", [hash])
                .map_err(|error| error.to_string())?;
        }
    }
    for connection in &connections {
        connection
            .execute_batch("COMMIT")
            .map_err(|error| error.to_string())?;
    }
    Ok(report)
}

fn register_blob(app_data_dir: &Path, database_url: &str, blob: &MediaBlob) -> Result<(), String> {
    let connection = Connection::open(database_path(app_data_dir, database_url)?)
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO media_blobs (
                blob_hash, relative_path, mime_type, file_extension, byte_size
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(blob_hash) DO UPDATE SET
                relative_path = excluded.relative_path,
                mime_type = excluded.mime_type,
                file_extension = excluded.file_extension,
                byte_size = excluded.byte_size,
                verified_at = CURRENT_TIMESTAMP",
            params![
                blob.blob_hash,
                blob.relative_path,
                blob.mime_type,
                blob.file_extension,
                blob.byte_size,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn ingest_media_blob(
    app_data_dir: &Path,
    database_url: &str,
    relative_path: &str,
) -> Result<MediaBlob, String> {
    crate::storage::prepare_graph_database(app_data_dir, database_url)?;
    let media_directory = crate::catalog::library_media_directory(app_data_dir, database_url)?;
    let source_relative = validated_relative_path(relative_path)?;
    let media_root = validated_relative_path(&media_directory)?;
    if !source_relative.starts_with(media_root) {
        return Err("Media file does not belong to this knowledge library".into());
    }
    let source_path = app_data_dir.join(source_relative);
    if !source_path.is_file() {
        return Err("Media file does not exist".into());
    }
    let (file_extension, mime_type) = extension_and_mime(source_relative)?;
    let (blob_hash, byte_size) = hash_file(&source_path)?;
    let relative_path = blob_relative_path(&blob_hash, &file_extension);
    let destination_path = app_data_dir.join(&relative_path);
    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if destination_path.is_file() {
        let (existing_hash, existing_size) = hash_file(&destination_path)?;
        if existing_hash != blob_hash || existing_size != byte_size {
            return Err("Existing media object failed integrity verification".into());
        }
    } else {
        let temporary_path = destination_path.with_extension(format!("{file_extension}.part"));
        fs::copy(&source_path, &temporary_path).map_err(|error| error.to_string())?;
        let (copied_hash, copied_size) = hash_file(&temporary_path)?;
        if copied_hash != blob_hash || copied_size != byte_size {
            let _ = fs::remove_file(&temporary_path);
            return Err("Copied media object failed integrity verification".into());
        }
        fs::rename(&temporary_path, &destination_path).map_err(|error| error.to_string())?;
    }
    let blob = MediaBlob {
        blob_hash,
        relative_path,
        mime_type,
        file_extension,
        byte_size,
    };
    register_blob(app_data_dir, database_url, &blob)?;
    Ok(blob)
}

pub fn find_media_blob(
    app_data_dir: &Path,
    database_url: &str,
    blob_hash: &str,
) -> Result<Option<MediaBlob>, String> {
    validate_blob_hash(blob_hash)?;
    let connection = Connection::open(database_path(app_data_dir, database_url)?)
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT blob_hash, relative_path, mime_type, file_extension, byte_size
             FROM media_blobs WHERE blob_hash = ?1",
            [blob_hash],
            |row| {
                Ok(MediaBlob {
                    blob_hash: row.get(0)?,
                    relative_path: row.get(1)?,
                    mime_type: row.get(2)?,
                    file_extension: row.get(3)?,
                    byte_size: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn expected_media_blob(
    app_data_dir: &Path,
    database_url: &str,
    blob_hash: &str,
) -> Result<MediaBlob, String> {
    validate_blob_hash(blob_hash)?;
    let connection = Connection::open(database_path(app_data_dir, database_url)?)
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT blob_hash, mime_type, file_extension, byte_size
             FROM attachments
             WHERE blob_hash = ?1
               AND mime_type IS NOT NULL
               AND file_extension IS NOT NULL
               AND byte_size IS NOT NULL
             ORDER BY id
             LIMIT 1",
            [blob_hash],
            |row| {
                let blob_hash: String = row.get(0)?;
                let file_extension: String = row.get(2)?;
                Ok(MediaBlob {
                    relative_path: blob_relative_path(&blob_hash, &file_extension),
                    blob_hash,
                    mime_type: row.get(1)?,
                    file_extension,
                    byte_size: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Knowledge library does not reference this media object".to_string())
}

pub fn missing_media_blobs(
    app_data_dir: &Path,
    database_url: &str,
) -> Result<Vec<MediaBlob>, String> {
    let connection = Connection::open(database_path(app_data_dir, database_url)?)
        .map_err(|error| error.to_string())?;
    let references = {
        let mut statement = connection
            .prepare(
                "SELECT blob_hash, mime_type, file_extension, byte_size
                 FROM attachments
                 WHERE kind IN ('image', 'video')
                   AND blob_hash IS NOT NULL
                 ORDER BY blob_hash, id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    drop(connection);

    let mut unique = BTreeMap::<String, MediaBlob>::new();
    for (blob_hash, mime_type, file_extension, byte_size) in references {
        let mime_type = mime_type
            .ok_or_else(|| format!("Media object {blob_hash} is missing its MIME type"))?;
        let file_extension = file_extension
            .ok_or_else(|| format!("Media object {blob_hash} is missing its file extension"))?;
        let byte_size = byte_size
            .ok_or_else(|| format!("Media object {blob_hash} is missing its byte size"))?;
        let blob = MediaBlob {
            relative_path: blob_relative_path(&blob_hash, &file_extension),
            blob_hash,
            mime_type,
            file_extension,
            byte_size,
        };
        validate_blob_hash(&blob.blob_hash)?;
        let (extension, mime_type) = extension_and_mime(Path::new(&blob.relative_path))?;
        if blob.byte_size < 0
            || extension != blob.file_extension
            || mime_type != blob.mime_type
            || unique
                .get(&blob.blob_hash)
                .is_some_and(|existing| existing != &blob)
        {
            return Err(format!(
                "Media object {} has conflicting or invalid metadata",
                blob.blob_hash
            ));
        }
        unique.insert(blob.blob_hash.clone(), blob);
    }

    let mut missing = Vec::new();
    for blob in unique.into_values() {
        let path = media_blob_path(app_data_dir, &blob)?;
        let is_verified = path.is_file()
            && hash_file(&path)
                .is_ok_and(|(hash, size)| hash == blob.blob_hash && size == blob.byte_size);
        if is_verified {
            register_blob(app_data_dir, database_url, &blob)?;
        } else {
            missing.push(blob);
        }
    }
    Ok(missing)
}

pub fn media_blob_path(app_data_dir: &Path, blob: &MediaBlob) -> Result<PathBuf, String> {
    validate_blob_hash(&blob.blob_hash)?;
    let expected = blob_relative_path(&blob.blob_hash, &blob.file_extension);
    if blob.relative_path != expected {
        return Err("Media object path does not match its hash".into());
    }
    Ok(app_data_dir.join(validated_relative_path(&blob.relative_path)?))
}

pub fn partial_media_blob_path(app_data_dir: &Path, blob: &MediaBlob) -> Result<PathBuf, String> {
    let destination = media_blob_path(app_data_dir, blob)?;
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Media object path is missing an extension".to_string())?;
    Ok(destination.with_extension(format!("{extension}.part")))
}

pub fn commit_downloaded_blob(
    app_data_dir: &Path,
    database_url: &str,
    blob: &MediaBlob,
) -> Result<MediaBlob, String> {
    let partial_path = partial_media_blob_path(app_data_dir, blob)?;
    let (actual_hash, actual_size) = hash_file(&partial_path)?;
    if actual_hash != blob.blob_hash || actual_size != blob.byte_size {
        let _ = fs::remove_file(&partial_path);
        return Err("Downloaded media object failed integrity verification".into());
    }
    let destination = media_blob_path(app_data_dir, blob)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::rename(&partial_path, &destination).map_err(|error| error.to_string())?;
    register_blob(app_data_dir, database_url, blob)?;
    Ok(blob.clone())
}

pub fn index_legacy_media(
    app_data_dir: &Path,
    database_url: &str,
    device_id: &str,
) -> Result<usize, String> {
    let connection = Connection::open(database_path(app_data_dir, database_url)?)
        .map_err(|error| error.to_string())?;
    let attachments = {
        let mut statement = connection
            .prepare(
                "SELECT id, owner_type, owner_id, kind, title, value
                 FROM attachments
                 WHERE kind IN ('image', 'video')
                   AND blob_hash IS NULL
                   AND length(value) > 0
                 ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok(crate::sync_store::Attachment {
                    id: row.get(0)?,
                    owner_type: row.get(1)?,
                    owner_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    value: row.get(5)?,
                    blob_hash: None,
                    mime_type: None,
                    file_extension: None,
                    byte_size: None,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    drop(connection);

    let mut indexed = 0;
    for mut attachment in attachments {
        if !app_data_dir.join(&attachment.value).is_file() {
            continue;
        }
        let blob = ingest_media_blob(app_data_dir, database_url, &attachment.value)?;
        attachment.value = blob.relative_path;
        attachment.blob_hash = Some(blob.blob_hash);
        attachment.mime_type = Some(blob.mime_type);
        attachment.file_extension = Some(blob.file_extension);
        attachment.byte_size = Some(blob.byte_size);
        crate::sync_store::apply_graph_mutation(
            app_data_dir,
            database_url,
            device_id,
            crate::sync_store::GraphMutation::SaveAttachment { attachment },
        )?;
        indexed += 1;
    }
    Ok(indexed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("rollmap-media-store-{}-{id}", std::process::id()));
            fs::create_dir_all(path.join("media")).expect("create test media directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ingests_and_deduplicates_a_verified_media_object() {
        let directory = TestDirectory::new();
        crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        crate::storage::prepare_graph_database(&directory.0, "sqlite:rollmap.db")
            .expect("prepare graph");
        fs::write(directory.0.join("media/first.jpg"), b"same-image").expect("write first image");
        fs::write(directory.0.join("media/second.jpg"), b"same-image").expect("write second image");

        let first = ingest_media_blob(&directory.0, "sqlite:rollmap.db", "media/first.jpg")
            .expect("ingest first image");
        let second = ingest_media_blob(&directory.0, "sqlite:rollmap.db", "media/second.jpg")
            .expect("ingest duplicate image");

        assert_eq!(first.blob_hash, second.blob_hash);
        assert_eq!(first.relative_path, second.relative_path);
        assert_eq!(first.mime_type, "image/jpeg");
        assert!(directory.0.join(&first.relative_path).is_file());
        assert_eq!(
            find_media_blob(&directory.0, "sqlite:rollmap.db", &first.blob_hash)
                .expect("read blob"),
            Some(first)
        );
    }

    #[test]
    fn lists_only_media_missing_from_the_content_pool() {
        let directory = TestDirectory::new();
        crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        crate::storage::prepare_graph_database(&directory.0, "sqlite:rollmap.db")
            .expect("prepare graph");
        fs::write(directory.0.join("media/present.jpg"), b"present-image")
            .expect("write present image");
        let present = ingest_media_blob(&directory.0, "sqlite:rollmap.db", "media/present.jpg")
            .expect("ingest present image");
        let missing_hash = Sha256::digest(b"missing-image")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let connection = Connection::open(directory.0.join("rollmap.db")).expect("open graph");
        connection
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('position-1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("insert owner");
        connection
            .execute(
                "INSERT INTO attachments (
                    id, owner_type, owner_id, kind, title, value,
                    blob_hash, mime_type, file_extension, byte_size
                 ) VALUES
                    ('present', 'position', 'position-1', 'image', 'Present', '', ?1, ?2, ?3, ?4),
                    ('missing', 'position', 'position-1', 'image', 'Missing', '', ?5, 'image/jpeg', 'jpg', 13)",
                params![
                    present.blob_hash,
                    present.mime_type,
                    present.file_extension,
                    present.byte_size,
                    missing_hash,
                ],
            )
            .expect("insert media attachments");
        connection
            .execute("DELETE FROM media_blobs", [])
            .expect("remove local mapping");
        drop(connection);

        let missing =
            missing_media_blobs(&directory.0, "sqlite:rollmap.db").expect("list missing media");

        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].blob_hash, missing_hash);
        assert_eq!(
            find_media_blob(&directory.0, "sqlite:rollmap.db", &present.blob_hash)
                .expect("read restored mapping"),
            Some(present)
        );
    }

    #[test]
    fn removes_a_download_that_fails_integrity_verification() {
        let directory = TestDirectory::new();
        crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        crate::storage::prepare_graph_database(&directory.0, "sqlite:rollmap.db")
            .expect("prepare graph");
        let expected_bytes = b"expected-image";
        let blob_hash = Sha256::digest(expected_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let blob = MediaBlob {
            relative_path: blob_relative_path(&blob_hash, "jpg"),
            blob_hash,
            mime_type: "image/jpeg".into(),
            file_extension: "jpg".into(),
            byte_size: expected_bytes.len() as i64,
        };
        let partial_path = partial_media_blob_path(&directory.0, &blob).expect("partial path");
        fs::create_dir_all(partial_path.parent().expect("partial parent"))
            .expect("create partial parent");
        fs::write(&partial_path, b"corrupted-image").expect("write corrupt partial");

        assert!(commit_downloaded_blob(&directory.0, "sqlite:rollmap.db", &blob).is_err());
        assert!(!partial_path.exists());
    }

    #[test]
    fn collects_a_blob_only_after_the_last_library_reference_is_deleted() {
        let directory = TestDirectory::new();
        let mut catalog =
            crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        let library_id = uuid::Uuid::new_v4().to_string();
        let second_database_url = format!("sqlite:rollmap-library-{library_id}.db");
        catalog.libraries.push(crate::catalog::KnowledgeLibrary {
            id: library_id.clone(),
            sync_library_id: uuid::Uuid::new_v4().to_string(),
            name: "Second library".into(),
            database_url: second_database_url.clone(),
            media_directory: format!("media/{library_id}"),
            browser_storage_key: format!("rollmap.graph.{library_id}"),
        });
        crate::catalog::save_library_catalog(&directory.0, catalog).expect("save catalog");
        crate::storage::prepare_graph_database(&directory.0, "sqlite:rollmap.db")
            .expect("prepare default graph");
        crate::storage::prepare_graph_database(&directory.0, &second_database_url)
            .expect("prepare second graph");
        fs::create_dir_all(directory.0.join(format!("media/{library_id}")))
            .expect("create second media directory");
        fs::write(directory.0.join("media/default.jpg"), b"shared-image")
            .expect("write default image");
        fs::write(
            directory.0.join(format!("media/{library_id}/second.jpg")),
            b"shared-image",
        )
        .expect("write second image");
        let default_blob =
            ingest_media_blob(&directory.0, "sqlite:rollmap.db", "media/default.jpg")
                .expect("ingest default image");
        let second_blob = ingest_media_blob(
            &directory.0,
            &second_database_url,
            &format!("media/{library_id}/second.jpg"),
        )
        .expect("ingest second image");
        assert_eq!(default_blob, second_blob);

        let second_connection =
            Connection::open(database_path(&directory.0, &second_database_url).unwrap())
                .expect("open second graph");
        second_connection
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('position-1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("insert owner");
        second_connection
            .execute(
                "INSERT INTO attachments (
                    id, owner_type, owner_id, kind, title, value,
                    blob_hash, mime_type, file_extension, byte_size
                 ) VALUES ('shared', 'position', 'position-1', 'image', 'Shared',
                    ?1, ?2, ?3, ?4, ?5)",
                params![
                    second_blob.relative_path,
                    second_blob.blob_hash,
                    second_blob.mime_type,
                    second_blob.file_extension,
                    second_blob.byte_size,
                ],
            )
            .expect("insert shared attachment");

        let retained = collect_media_garbage(&directory.0, false).expect("collect stale mapping");
        assert_eq!(retained.reclaimable_files, 0);
        assert_eq!(retained.removed_records, 1);
        assert!(directory.0.join(&second_blob.relative_path).is_file());
        assert!(
            find_media_blob(&directory.0, "sqlite:rollmap.db", &second_blob.blob_hash)
                .expect("read default mapping")
                .is_none()
        );
        assert!(
            find_media_blob(&directory.0, &second_database_url, &second_blob.blob_hash)
                .expect("read second mapping")
                .is_some()
        );

        second_connection
            .execute("DELETE FROM attachments WHERE id = 'shared'", [])
            .expect("delete last reference");
        drop(second_connection);
        let preview = collect_media_garbage(&directory.0, true).expect("preview garbage");
        assert_eq!(preview.reclaimable_files, 1);
        assert_eq!(preview.reclaimable_bytes, second_blob.byte_size as u64);
        assert_eq!(preview.removed_files, 0);
        assert!(directory.0.join(&second_blob.relative_path).is_file());

        let collected = collect_media_garbage(&directory.0, false).expect("collect garbage");
        assert_eq!(collected.removed_files, 1);
        assert_eq!(collected.removed_bytes, second_blob.byte_size as u64);
        assert_eq!(collected.removed_records, 1);
        assert!(!directory.0.join(&second_blob.relative_path).exists());
    }

    #[test]
    fn collects_unreferenced_partial_files_but_preserves_unknown_files() {
        let directory = TestDirectory::new();
        crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        crate::storage::prepare_graph_database(&directory.0, "sqlite:rollmap.db")
            .expect("prepare graph");
        fs::write(directory.0.join("media/orphan.jpg"), b"orphan-image")
            .expect("write orphan image");
        let blob = ingest_media_blob(&directory.0, "sqlite:rollmap.db", "media/orphan.jpg")
            .expect("ingest orphan image");
        let partial_path = partial_media_blob_path(&directory.0, &blob).expect("partial path");
        fs::write(&partial_path, b"partial").expect("write partial file");
        let unknown_path = partial_path
            .parent()
            .expect("pool directory")
            .join("keep-me.txt");
        fs::write(&unknown_path, b"unknown").expect("write unknown file");

        let preview = collect_media_garbage(&directory.0, true).expect("preview garbage");
        assert_eq!(preview.reclaimable_files, 2);
        assert_eq!(preview.reclaimable_partial_files, 1);
        assert_eq!(
            preview.reclaimable_bytes,
            blob.byte_size as u64 + b"partial".len() as u64
        );

        let collected = collect_media_garbage(&directory.0, false).expect("collect garbage");
        assert_eq!(collected.removed_files, 2);
        assert_eq!(collected.removed_partial_files, 1);
        assert!(!directory.0.join(&blob.relative_path).exists());
        assert!(!partial_path.exists());
        assert!(unknown_path.is_file());
    }
}
