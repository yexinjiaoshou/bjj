use axum::{
    body::Body,
    extract::{Path as RoutePath, State},
    http::{
        header::{
            ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        },
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use std::{
    net::Ipv4Addr,
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    net::TcpListener,
    sync::Mutex,
    task::JoinHandle,
};
use tokio_util::io::ReaderStream;

#[derive(Default)]
pub struct MediaPreviewServerManager {
    running: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    port: u16,
    token: String,
    task: JoinHandle<Result<(), String>>,
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct PreviewState {
    app_data_dir: PathBuf,
    token: String,
}

struct PreviewFile {
    path: PathBuf,
    mime_type: &'static str,
    byte_size: u64,
}

#[derive(Debug)]
struct PreviewError {
    status: StatusCode,
    message: String,
}

impl PreviewError {
    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn invalid_range(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl IntoResponse for PreviewError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

impl MediaPreviewServerManager {
    pub async fn preview_url(
        &self,
        app_data_dir: PathBuf,
        relative_path: String,
    ) -> Result<String, String> {
        resolve_preview_file(&app_data_dir, &relative_path)
            .await
            .map_err(|error| error.message)?;

        let encoded_path = URL_SAFE_NO_PAD.encode(relative_path.as_bytes());
        let mut running = self.running.lock().await;
        if running
            .as_ref()
            .is_some_and(|server| server.task.is_finished())
        {
            running.take();
        }
        if running.is_none() {
            *running = Some(start_server(app_data_dir).await?);
        }
        let server = running
            .as_ref()
            .ok_or_else(|| "Media preview server is unavailable".to_string())?;
        Ok(format!(
            "http://127.0.0.1:{}/media/{}/{}",
            server.port, server.token, encoded_path
        ))
    }
}

async fn start_server(app_data_dir: PathBuf) -> Result<RunningServer, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let mut token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let state = Arc::new(PreviewState {
        app_data_dir,
        token: token.clone(),
    });
    let router = Router::new()
        .route("/media/{token}/{encoded_path}", get(serve_media))
        .with_state(state);
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .map_err(|error| error.to_string())
    });
    Ok(RunningServer { port, token, task })
}

fn validated_media_path(relative_path: &str) -> Result<(&Path, &'static str), PreviewError> {
    let path = Path::new(relative_path);
    let mut components = path.components();
    if path.is_absolute()
        || !matches!(components.next(), Some(Component::Normal(value)) if value == "media")
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PreviewError::not_found("Invalid media preview path"));
    }
    let mime_type = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        _ => return Err(PreviewError::not_found("Unsupported media preview type")),
    };
    Ok((path, mime_type))
}

async fn resolve_preview_file(
    app_data_dir: &Path,
    relative_path: &str,
) -> Result<PreviewFile, PreviewError> {
    let (relative_path, mime_type) = validated_media_path(relative_path)?;
    let media_root = tokio::fs::canonicalize(app_data_dir.join("media"))
        .await
        .map_err(|_| PreviewError::not_found("Media directory is unavailable"))?;
    let path = tokio::fs::canonicalize(app_data_dir.join(relative_path))
        .await
        .map_err(|_| PreviewError::not_found("Media preview is unavailable"))?;
    if !path.starts_with(&media_root) {
        return Err(PreviewError::not_found("Invalid media preview path"));
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| PreviewError::not_found("Media preview is unavailable"))?;
    if !metadata.is_file() {
        return Err(PreviewError::not_found("Media preview is unavailable"));
    }
    Ok(PreviewFile {
        path,
        mime_type,
        byte_size: metadata.len(),
    })
}

fn requested_byte_range(
    headers: &HeaderMap,
    total_size: u64,
) -> Result<(u64, u64, bool), PreviewError> {
    let Some(value) = headers.get(RANGE) else {
        return Ok((0, total_size.saturating_sub(1), false));
    };
    if total_size == 0 {
        return Err(PreviewError::invalid_range(
            "Empty media files do not have byte ranges",
        ));
    }
    let value = value
        .to_str()
        .map_err(|_| PreviewError::invalid_range("Invalid media byte range"))?;
    let range = value
        .strip_prefix("bytes=")
        .filter(|value| !value.contains(','))
        .ok_or_else(|| PreviewError::invalid_range("Only one media byte range is supported"))?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| PreviewError::invalid_range("Invalid media byte range"))?;
    let (start, end) = if start.is_empty() {
        let suffix_length = end
            .parse::<u64>()
            .map_err(|_| PreviewError::invalid_range("Invalid media byte range"))?;
        if suffix_length == 0 {
            return Err(PreviewError::invalid_range("Invalid media byte range"));
        }
        (total_size.saturating_sub(suffix_length), total_size - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| PreviewError::invalid_range("Invalid media byte range"))?;
        let end = if end.is_empty() {
            total_size - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| PreviewError::invalid_range("Invalid media byte range"))?
                .min(total_size - 1)
        };
        (start, end)
    };
    if start >= total_size || start > end {
        return Err(PreviewError::invalid_range(
            "Media byte range is outside the file",
        ));
    }
    Ok((start, end, true))
}

async fn serve_media(
    State(state): State<Arc<PreviewState>>,
    RoutePath((token, encoded_path)): RoutePath<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, PreviewError> {
    if token != state.token {
        return Err(PreviewError::not_found("Media preview is unavailable"));
    }
    let relative_path = URL_SAFE_NO_PAD
        .decode(encoded_path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| PreviewError::not_found("Invalid media preview path"))?;
    let preview = resolve_preview_file(&state.app_data_dir, &relative_path).await?;
    let (start, end, is_partial) = requested_byte_range(&headers, preview.byte_size)?;
    let content_length = if preview.byte_size == 0 {
        0
    } else {
        end - start + 1
    };
    let mut file = tokio::fs::File::open(preview.path)
        .await
        .map_err(|error| PreviewError::not_found(error.to_string()))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| PreviewError::internal(error.to_string()))?;
    let stream = ReaderStream::new(file.take(content_length));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let response_headers = response.headers_mut();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static(preview.mime_type));
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string())
            .map_err(|_| PreviewError::internal("Invalid media content length"))?,
    );
    if is_partial {
        response_headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{}", preview.byte_size))
                .map_err(|_| PreviewError::internal("Invalid media content range"))?,
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_media_paths_and_ranges() {
        assert!(validated_media_path("media/staging/video.mp4").is_ok());
        assert!(validated_media_path("media/blobs/sha256/aa/video.m4v").is_ok());
        assert!(validated_media_path("../media/video.mp4").is_err());
        assert!(validated_media_path("media/../video.mp4").is_err());
        assert!(validated_media_path("media/video.exe").is_err());

        let mut headers = HeaderMap::new();
        headers.insert(RANGE, HeaderValue::from_static("bytes=2-5"));
        assert_eq!(requested_byte_range(&headers, 10).unwrap(), (2, 5, true));
        headers.insert(RANGE, HeaderValue::from_static("bytes=-3"));
        assert_eq!(requested_byte_range(&headers, 10).unwrap(), (7, 9, true));
    }

    #[tokio::test]
    async fn serves_a_private_ranged_preview() {
        let directory =
            std::env::temp_dir().join(format!("rollmap-media-preview-{}", uuid::Uuid::new_v4()));
        let media_directory = directory.join("media");
        std::fs::create_dir_all(&media_directory).unwrap();
        std::fs::write(media_directory.join("video.mp4"), b"preview-bytes").unwrap();

        let manager = MediaPreviewServerManager::default();
        let url = manager
            .preview_url(directory.clone(), "media/video.mp4".into())
            .await
            .unwrap();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .header(RANGE, "bytes=2-6")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 2-6/13");
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"eview");

        drop(manager);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
