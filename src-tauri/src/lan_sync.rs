use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, State},
    http::{
        header::{
            ACCEPT_RANGES, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, RANGE,
        },
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use rand_core::{OsRng, RngCore};
use reqwest::{redirect::Policy, Client, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs::OpenOptions,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::TcpListener,
    sync::{oneshot, Mutex as AsyncMutex},
    task::JoinHandle,
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
use uuid::Uuid;

const AUTH_CHALLENGE_TTL_MS: i64 = 60_000;
const AUTH_SESSION_TTL_MS: i64 = 60 * 60 * 1_000;
const MAX_HTTP_BODY_BYTES: usize = 32 * 1024 * 1024;
const MEDIA_TRANSFER_CANCELLED: &str = "Media transfer was cancelled";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerInfo {
    port: u16,
    base_urls: Vec<String>,
    protocol_major: u32,
    transport_security: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSyncReport {
    remote_device_id: String,
    library_count: usize,
    successful_libraries: usize,
    failed_libraries: Vec<LanLibraryFailure>,
    catalog_changes: usize,
    pushed_changes: usize,
    pulled_changes: usize,
    pushed_snapshots: usize,
    pulled_snapshots: usize,
    conflicts: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanLibraryFailure {
    sync_library_id: String,
    error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTransferProgress {
    transfer_id: String,
    sync_library_id: String,
    files_total: usize,
    files_processed: usize,
    bytes_total: u64,
    bytes_completed: u64,
    current_blob_hash: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTransferFailure {
    blob_hash: String,
    error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTransferReport {
    transfer_id: String,
    sync_library_id: String,
    files_total: usize,
    files_downloaded: usize,
    bytes_total: u64,
    bytes_completed: u64,
    failures: Vec<MediaTransferFailure>,
    cancelled: bool,
}

#[derive(Default)]
pub struct MediaTransferManager {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl MediaTransferManager {
    fn begin(&self, transfer_id: &str) -> Result<CancellationToken, String> {
        Uuid::parse_str(transfer_id)
            .map_err(|_| "Media transfer identity must be a UUID".to_string())?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Media transfer cancellation state is unavailable".to_string())?;
        if active.contains_key(transfer_id) {
            return Err("Media transfer is already running".into());
        }
        let cancellation = CancellationToken::new();
        active.insert(transfer_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    fn finish(&self, transfer_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(transfer_id);
        }
    }

    pub fn cancel(&self, transfer_id: &str) -> Result<bool, String> {
        Uuid::parse_str(transfer_id)
            .map_err(|_| "Media transfer identity must be a UUID".to_string())?;
        let active = self
            .active
            .lock()
            .map_err(|_| "Media transfer cancellation state is unavailable".to_string())?;
        let Some(cancellation) = active.get(transfer_id) else {
            return Ok(false);
        };
        cancellation.cancel();
        Ok(true)
    }
}

struct RunningServer {
    info: LanServerInfo,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
    discovery: crate::discovery::LanDiscovery,
}

#[derive(Default)]
pub struct LanServerManager {
    running: AsyncMutex<Option<RunningServer>>,
}

#[derive(Clone)]
struct LanApiState {
    app_data_dir: PathBuf,
    auth: Arc<Mutex<AuthState>>,
}

#[derive(Default)]
struct AuthState {
    challenges: HashMap<String, PendingChallenge>,
    sessions: HashMap<String, AuthSession>,
}

struct PendingChallenge {
    peer_device_id: String,
    challenge: String,
    expires_at_ms: i64,
}

struct AuthSession {
    peer_device_id: String,
    expires_at_ms: i64,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiErrorBody {
    error: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn range_not_satisfiable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeRequest {
    peer_device_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    challenge_id: String,
    challenge: String,
    expires_at_ms: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionRequest {
    peer_device_id: String,
    challenge_id: String,
    signature: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    token: String,
    expires_at_ms: i64,
}

impl LanServerManager {
    pub async fn start(&self, app_data_dir: PathBuf) -> Result<LanServerInfo, String> {
        let mut running = self.running.lock().await;
        if let Some(server) = running.as_ref() {
            return Ok(server.info.clone());
        }
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let info = LanServerInfo {
            port,
            base_urls: server_base_urls(port),
            protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
            transport_security: "testOnlyHttpSignedSession".into(),
        };
        let local_device_id = {
            let identity_directory = app_data_dir.clone();
            tokio::task::spawn_blocking(move || {
                crate::identity::device_identity(&identity_directory)
            })
            .await
            .map_err(|error| error.to_string())??
            .device_id
        };
        let discovery = crate::discovery::LanDiscovery::start(port, local_device_id)?;
        let state = Arc::new(LanApiState {
            app_data_dir,
            auth: Arc::new(Mutex::new(AuthState::default())),
        });
        let router = api_router(state);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_receiver.await;
                })
                .await
                .map_err(|error| error.to_string())
        });
        *running = Some(RunningServer {
            info: info.clone(),
            shutdown: Some(shutdown),
            task,
            discovery,
        });
        Ok(info)
    }

    pub async fn status(&self) -> Option<LanServerInfo> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|server| server.info.clone())
    }

    pub async fn discovered_peers(&self) -> Vec<crate::discovery::DiscoveredLanPeer> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|server| server.discovery.peers())
            .unwrap_or_default()
    }

    pub async fn stop(&self) -> Result<bool, String> {
        let server = self.running.lock().await.take();
        let Some(mut server) = server else {
            return Ok(false);
        };
        if let Some(shutdown) = server.shutdown.take() {
            let _ = shutdown.send(());
        }
        server.discovery.stop().await;
        server.task.await.map_err(|error| error.to_string())??;
        Ok(true)
    }
}

fn server_base_urls(port: u16) -> Vec<String> {
    let mut addresses = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    if let Some(address) = primary_lan_address() {
        addresses.push(address);
    }
    addresses.sort_unstable();
    addresses.dedup();
    addresses
        .into_iter()
        .map(|address| match address {
            IpAddr::V4(address) => format!("http://{address}:{port}"),
            IpAddr::V6(address) => format!("http://[{address}]:{port}"),
        })
        .collect()
}

fn primary_lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
    let address = socket.local_addr().ok()?.ip();
    (!address.is_loopback() && !address.is_unspecified()).then_some(address)
}

fn api_router(state: Arc<LanApiState>) -> Router {
    Router::new()
        .route("/v1/hello", get(api_hello))
        .route("/v1/pair/complete", post(api_complete_pairing))
        .route("/v1/auth/challenge", post(api_create_challenge))
        .route("/v1/auth/session", post(api_create_session))
        .route("/v1/catalog", get(api_pull_catalog).post(api_push_catalog))
        .route("/v1/sync/pull", post(api_pull_changes))
        .route("/v1/sync/pull-snapshot", post(api_pull_snapshot))
        .route("/v1/sync/push", post(api_push_changes))
        .route("/v1/sync/push-snapshot", post(api_push_snapshot))
        .route("/v1/sync/ack", post(api_acknowledge))
        .route(
            "/v1/sync/blob/{sync_library_id}/{blob_hash}",
            get(api_get_blob),
        )
        .layer(DefaultBodyLimit::max(MAX_HTTP_BODY_BYTES))
        .with_state(state)
}

fn now_ms() -> Result<i64, String> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(milliseconds).map_err(|_| "System time is outside the protocol range".into())
}

fn lock_auth(state: &LanApiState) -> Result<MutexGuard<'_, AuthState>, ApiError> {
    state
        .auth
        .lock()
        .map_err(|_| ApiError::internal("LAN authentication state is unavailable"))
}

async fn api_blocking<T, F>(operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .map_err(ApiError::bad_request)
}

async fn api_hello(
    State(state): State<Arc<LanApiState>>,
) -> Result<Json<crate::sync_protocol::ProtocolHello>, ApiError> {
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || crate::sync_protocol::hello(&app_data_dir))
        .await
        .map(Json)
}

async fn api_complete_pairing(
    State(state): State<Arc<LanApiState>>,
    Json(request): Json<crate::identity::PairingRequest>,
) -> Result<Json<crate::identity::TrustedPeer>, ApiError> {
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || crate::identity::complete_pairing(&app_data_dir, request))
        .await
        .map(Json)
}

async fn api_create_challenge(
    State(state): State<Arc<LanApiState>>,
    Json(request): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, ApiError> {
    Uuid::parse_str(&request.peer_device_id)
        .map_err(|_| ApiError::bad_request("Peer device identity must be a UUID"))?;
    let now = now_ms().map_err(ApiError::internal)?;
    let expires_at_ms = now + AUTH_CHALLENGE_TTL_MS;
    let challenge_id = Uuid::new_v4().to_string();
    let challenge = crate::identity::generate_authentication_challenge();
    let mut auth = lock_auth(&state)?;
    auth.challenges
        .retain(|_, pending| pending.expires_at_ms >= now);
    auth.challenges.insert(
        challenge_id.clone(),
        PendingChallenge {
            peer_device_id: request.peer_device_id,
            challenge: challenge.clone(),
            expires_at_ms,
        },
    );
    Ok(Json(ChallengeResponse {
        challenge_id,
        challenge,
        expires_at_ms,
    }))
}

async fn api_create_session(
    State(state): State<Arc<LanApiState>>,
    Json(request): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    let now = now_ms().map_err(ApiError::internal)?;
    let pending = {
        let mut auth = lock_auth(&state)?;
        auth.challenges.remove(&request.challenge_id)
    }
    .ok_or_else(|| ApiError::unauthorized("Authentication challenge is unknown"))?;
    if pending.expires_at_ms < now {
        return Err(ApiError::unauthorized(
            "Authentication challenge has expired",
        ));
    }
    if pending.peer_device_id != request.peer_device_id {
        return Err(ApiError::unauthorized(
            "Authentication challenge belongs to another peer",
        ));
    }
    let app_data_dir = state.app_data_dir.clone();
    let peer_device_id = request.peer_device_id.clone();
    let challenge = pending.challenge;
    let signature = request.signature;
    let verified = api_blocking(move || {
        crate::identity::verify_trusted_peer_signature(
            &app_data_dir,
            &peer_device_id,
            &challenge,
            &signature,
        )
    })
    .await?;
    if !verified {
        return Err(ApiError::unauthorized(
            "Peer authentication signature is invalid",
        ));
    }
    let mut token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let expires_at_ms = now + AUTH_SESSION_TTL_MS;
    let mut auth = lock_auth(&state)?;
    auth.sessions
        .retain(|_, session| session.expires_at_ms >= now);
    auth.sessions.insert(
        token.clone(),
        AuthSession {
            peer_device_id: request.peer_device_id,
            expires_at_ms,
        },
    );
    Ok(Json(SessionResponse {
        token,
        expires_at_ms,
    }))
}

async fn api_pull_catalog(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
) -> Result<Json<crate::catalog::CatalogManifest>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || crate::catalog::export_catalog_manifest(&app_data_dir, &peer_device_id))
        .await
        .map(Json)
}

async fn api_push_catalog(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(manifest): Json<crate::catalog::CatalogManifest>,
) -> Result<Json<crate::catalog::CatalogMergeResult>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || {
        crate::catalog::merge_catalog_manifest(&app_data_dir, &peer_device_id, manifest)
    })
    .await
    .map(Json)
}

fn authenticated_peer(state: &LanApiState, headers: &HeaderMap) -> Result<String, ApiError> {
    let authorization = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .ok_or_else(|| ApiError::unauthorized("A bearer session is required"))?;
    let now = now_ms().map_err(ApiError::internal)?;
    let mut auth = lock_auth(state)?;
    auth.sessions
        .retain(|_, session| session.expires_at_ms >= now);
    auth.sessions
        .get(authorization)
        .map(|session| session.peer_device_id.clone())
        .ok_or_else(|| ApiError::unauthorized("Bearer session is invalid or expired"))
}

async fn api_pull_changes(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(request): Json<crate::sync_protocol::PullChangesRequest>,
) -> Result<Json<crate::sync_store::SyncBatch>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || {
        crate::sync_protocol::pull_changes(&app_data_dir, &peer_device_id, request)
    })
    .await
    .map(Json)
}

async fn api_pull_snapshot(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(request): Json<crate::sync_protocol::LibrarySnapshotRequest>,
) -> Result<Json<crate::sync_store::SyncSnapshot>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || {
        crate::sync_protocol::pull_snapshot(&app_data_dir, &peer_device_id, request)
    })
    .await
    .map(Json)
}

async fn api_push_changes(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(request): Json<crate::sync_protocol::PushChangesRequest>,
) -> Result<Json<crate::sync_store::SyncMergeResult>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || {
        crate::sync_protocol::push_changes(&app_data_dir, &peer_device_id, request)
    })
    .await
    .map(Json)
}

async fn api_push_snapshot(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(request): Json<crate::sync_protocol::PushSnapshotRequest>,
) -> Result<Json<crate::sync_store::SyncMergeResult>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || {
        crate::sync_protocol::push_snapshot(&app_data_dir, &peer_device_id, request)
    })
    .await
    .map(Json)
}

async fn api_acknowledge(
    State(state): State<Arc<LanApiState>>,
    headers: HeaderMap,
    Json(request): Json<crate::sync_protocol::AcknowledgeRequest>,
) -> Result<Json<i64>, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    api_blocking(move || crate::sync_protocol::acknowledge(&app_data_dir, &peer_device_id, request))
        .await
        .map(Json)
}

fn requested_byte_range(
    headers: &HeaderMap,
    total_size: u64,
) -> Result<(u64, u64, bool), ApiError> {
    let Some(value) = headers.get(RANGE) else {
        return Ok((0, total_size.saturating_sub(1), false));
    };
    if total_size == 0 {
        return Err(ApiError::range_not_satisfiable(
            "Empty media objects do not have byte ranges",
        ));
    }
    let value = value
        .to_str()
        .map_err(|_| ApiError::bad_request("Media range header is invalid"))?;
    let range = value
        .strip_prefix("bytes=")
        .filter(|value| !value.contains(','))
        .ok_or_else(|| ApiError::bad_request("Only one byte range is supported"))?;
    let (start, end) = range
        .split_once('-')
        .ok_or_else(|| ApiError::bad_request("Media range header is invalid"))?;
    if start.is_empty() {
        return Err(ApiError::bad_request(
            "Suffix byte ranges are not supported",
        ));
    }
    let start = start
        .parse::<u64>()
        .map_err(|_| ApiError::bad_request("Media range start is invalid"))?;
    let end = if end.is_empty() {
        total_size - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| ApiError::bad_request("Media range end is invalid"))?
            .min(total_size - 1)
    };
    if start >= total_size || start > end {
        return Err(ApiError::range_not_satisfiable(
            "Media byte range is outside the object",
        ));
    }
    Ok((start, end, true))
}

async fn api_get_blob(
    State(state): State<Arc<LanApiState>>,
    RoutePath((sync_library_id, blob_hash)): RoutePath<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let peer_device_id = authenticated_peer(&state, &headers)?;
    let app_data_dir = state.app_data_dir.clone();
    let (blob, path) = api_blocking(move || {
        let database_url = crate::catalog::authorized_library_database_url(
            &app_data_dir,
            &peer_device_id,
            &sync_library_id,
        )?;
        let blob = crate::media_store::find_media_blob(&app_data_dir, &database_url, &blob_hash)?
            .ok_or_else(|| "Media object is not available on this device".to_string())?;
        let path = crate::media_store::media_blob_path(&app_data_dir, &blob)?;
        if !path.is_file() {
            return Err("Media object is not available on this device".into());
        }
        Ok((blob, path))
    })
    .await
    .map_err(|error| {
        if error.message.contains("not available") {
            ApiError::not_found(error.message)
        } else {
            error
        }
    })?;

    let total_size = u64::try_from(blob.byte_size)
        .map_err(|_| ApiError::internal("Media object size is invalid"))?;
    let (start, end, is_partial) = requested_byte_range(&headers, total_size)?;
    let content_length = if total_size == 0 { 0 } else { end - start + 1 };
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| ApiError::not_found(error.to_string()))?;
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let stream = ReaderStream::new(file.take(content_length));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let response_headers = response.headers_mut();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&blob.mime_type)
            .map_err(|_| ApiError::internal("Media MIME type is invalid"))?,
    );
    response_headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string())
            .map_err(|_| ApiError::internal("Media content length is invalid"))?,
    );
    response_headers.insert(
        ETAG,
        HeaderValue::from_str(&format!("\"{}\"", blob.blob_hash))
            .map_err(|_| ApiError::internal("Media ETag is invalid"))?,
    );
    if is_partial {
        response_headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{total_size}"))
                .map_err(|_| ApiError::internal("Media content range is invalid"))?,
        );
    }
    Ok(response)
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

fn media_http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30 * 60))
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
}

fn endpoint(base_url: &str, path: &str) -> Result<Url, String> {
    let base = Url::parse(base_url).map_err(|_| "LAN server URL is invalid".to_string())?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("LAN server URL must use HTTP or HTTPS".into());
    }
    if base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("LAN server URL contains unsupported components".into());
    }
    if !matches!(base.path(), "" | "/") {
        return Err("LAN server URL must not contain a path".into());
    }
    base.join(path.trim_start_matches('/'))
        .map_err(|error| error.to_string())
}

async fn decode_response<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let message = serde_json::from_str::<ApiErrorBody>(&body)
            .map(|error| error.error)
            .unwrap_or(body);
        return Err(format!("LAN server returned {status}: {message}"));
    }
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

async fn get_json<T: DeserializeOwned>(
    client: &Client,
    base_url: &str,
    path: &str,
) -> Result<T, String> {
    let response = client
        .get(endpoint(base_url, path)?)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    decode_response(response).await
}

async fn get_json_authenticated<T: DeserializeOwned>(
    client: &Client,
    base_url: &str,
    path: &str,
    bearer_token: &str,
) -> Result<T, String> {
    let response = client
        .get(endpoint(base_url, path)?)
        .bearer_auth(bearer_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    decode_response(response).await
}

async fn post_json<B: Serialize, T: DeserializeOwned>(
    client: &Client,
    base_url: &str,
    path: &str,
    body: &B,
    bearer_token: Option<&str>,
) -> Result<T, String> {
    let mut request = client.post(endpoint(base_url, path)?).json(body);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    decode_response(response).await
}

async fn client_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

pub async fn pair_with_server(
    app_data_dir: PathBuf,
    base_url: String,
    offer: crate::identity::PairingOffer,
    peer_display_name: String,
    sync_library_ids: Vec<String>,
) -> Result<crate::identity::TrustedPeer, String> {
    let client = http_client()?;
    let hello: crate::sync_protocol::ProtocolHello =
        get_json(&client, &base_url, "/v1/hello").await?;
    if hello.protocol_major != crate::sync_protocol::PROTOCOL_MAJOR
        || offer.protocol_major != hello.protocol_major
    {
        return Err("Pairing server uses an incompatible protocol version".into());
    }
    if hello.device.device_id != offer.device_id
        || hello.device.identity_public_key != offer.identity_public_key
        || hello.device.fingerprint != offer.fingerprint
    {
        return Err("Pairing offer does not match the LAN server identity".into());
    }
    let request = {
        let app_data_dir = app_data_dir.clone();
        let offer = offer.clone();
        let peer_display_name = peer_display_name.clone();
        let sync_library_ids = sync_library_ids.clone();
        client_blocking(move || {
            crate::identity::create_pairing_request(
                &app_data_dir,
                offer,
                &peer_display_name,
                sync_library_ids,
            )
        })
        .await?
    };
    let mut trusted_host = {
        let app_data_dir = app_data_dir.clone();
        let offer = offer.clone();
        let sync_library_ids = sync_library_ids.clone();
        client_blocking(move || {
            crate::identity::trust_pairing_offer(&app_data_dir, offer, sync_library_ids)
        })
        .await?
    };
    let _: crate::identity::TrustedPeer =
        post_json(&client, &base_url, "/v1/pair/complete", &request, None).await?;
    {
        let app_data_dir = app_data_dir.clone();
        let peer_device_id = offer.device_id;
        let base_url = base_url.clone();
        client_blocking(move || {
            crate::catalog::save_trusted_peer_endpoint(&app_data_dir, &peer_device_id, &base_url)
        })
        .await?;
    }
    trusted_host.base_url = Some(base_url);
    Ok(trusted_host)
}

async fn authenticate(
    client: &Client,
    app_data_dir: &Path,
    base_url: &str,
) -> Result<SessionResponse, String> {
    let identity = {
        let app_data_dir = app_data_dir.to_path_buf();
        client_blocking(move || crate::identity::device_identity(&app_data_dir)).await?
    };
    let challenge: ChallengeResponse = post_json(
        client,
        base_url,
        "/v1/auth/challenge",
        &ChallengeRequest {
            peer_device_id: identity.device_id.clone(),
        },
        None,
    )
    .await?;
    let signature = {
        let app_data_dir = app_data_dir.to_path_buf();
        let challenge_value = challenge.challenge.clone();
        client_blocking(move || {
            crate::identity::sign_authentication_challenge(&app_data_dir, &challenge_value)
        })
        .await?
    };
    post_json(
        client,
        base_url,
        "/v1/auth/session",
        &SessionRequest {
            peer_device_id: identity.device_id,
            challenge_id: challenge.challenge_id,
            signature,
        },
        None,
    )
    .await
}

pub async fn sync_with_server(
    app_data_dir: PathBuf,
    base_url: String,
    remote_device_id: String,
) -> Result<LanSyncReport, String> {
    Uuid::parse_str(&remote_device_id)
        .map_err(|_| "Remote device identity must be a UUID".to_string())?;
    let client = http_client()?;
    let hello: crate::sync_protocol::ProtocolHello =
        get_json(&client, &base_url, "/v1/hello").await?;
    if hello.protocol_major != crate::sync_protocol::PROTOCOL_MAJOR {
        return Err("LAN server uses an incompatible protocol version".into());
    }
    if hello.device.device_id != remote_device_id {
        return Err("LAN server identity does not match the trusted peer".into());
    }
    let session = authenticate(&client, &app_data_dir, &base_url).await?;
    let local_manifest = {
        let app_data_dir = app_data_dir.clone();
        let remote_device_id = remote_device_id.clone();
        client_blocking(move || {
            crate::catalog::export_catalog_manifest(&app_data_dir, &remote_device_id)
        })
        .await?
    };
    let remote_merge: crate::catalog::CatalogMergeResult = post_json(
        &client,
        &base_url,
        "/v1/catalog",
        &local_manifest,
        Some(&session.token),
    )
    .await?;
    let remote_manifest: crate::catalog::CatalogManifest =
        get_json_authenticated(&client, &base_url, "/v1/catalog", &session.token).await?;
    let local_merge = {
        let app_data_dir = app_data_dir.clone();
        let remote_device_id = remote_device_id.clone();
        client_blocking(move || {
            crate::catalog::merge_catalog_manifest(
                &app_data_dir,
                &remote_device_id,
                remote_manifest,
            )
        })
        .await?
    };
    let libraries = {
        let app_data_dir = app_data_dir.clone();
        let remote_device_id = remote_device_id.clone();
        client_blocking(move || {
            crate::catalog::authorized_sync_libraries(&app_data_dir, &remote_device_id)
        })
        .await?
    };
    let mut report = LanSyncReport {
        remote_device_id: remote_device_id.clone(),
        library_count: libraries.len(),
        catalog_changes: remote_merge.created
            + remote_merge.updated
            + remote_merge.deleted
            + local_merge.created
            + local_merge.updated
            + local_merge.deleted,
        ..LanSyncReport::default()
    };
    for library in libraries {
        let sync_library_id = library.sync_library_id.clone();
        if let Err(error) = prepare_local_library(&app_data_dir, &library.database_url).await {
            report.failed_libraries.push(LanLibraryFailure {
                sync_library_id,
                error,
            });
            continue;
        }
        if let Err(error) = push_library(
            &client,
            &app_data_dir,
            &base_url,
            &session.token,
            &remote_device_id,
            &library,
            &mut report,
        )
        .await
        {
            report.failed_libraries.push(LanLibraryFailure {
                sync_library_id,
                error,
            });
            continue;
        }
        if let Err(error) = pull_library(
            &client,
            &app_data_dir,
            &base_url,
            &session.token,
            &remote_device_id,
            &library,
            &mut report,
        )
        .await
        {
            report.failed_libraries.push(LanLibraryFailure {
                sync_library_id,
                error,
            });
            continue;
        }
        compact_local_sync_journal_best_effort(&app_data_dir, &library.database_url).await;
        report.successful_libraries += 1;
    }
    {
        let app_data_dir = app_data_dir.clone();
        let remote_device_id = remote_device_id.clone();
        let base_url = base_url.clone();
        client_blocking(move || {
            crate::catalog::save_trusted_peer_endpoint(&app_data_dir, &remote_device_id, &base_url)
        })
        .await?;
    }
    Ok(report)
}

async fn download_blob_from_peer(
    app_data_dir: &Path,
    peer: &crate::catalog::MediaSourcePeer,
    sync_library_id: &str,
    blob_hash: &str,
    cancellation: &CancellationToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<crate::media_store::MediaBlob, String> {
    if cancellation.is_cancelled() {
        return Err(MEDIA_TRANSFER_CANCELLED.into());
    }
    let client = media_http_client()?;
    let hello: crate::sync_protocol::ProtocolHello = tokio::select! {
        _ = cancellation.cancelled() => return Err(MEDIA_TRANSFER_CANCELLED.into()),
        result = get_json(&client, &peer.base_url, "/v1/hello") => result?,
    };
    if hello.device.device_id != peer.device_id {
        return Err("LAN server identity does not match the trusted peer".into());
    }
    let session = tokio::select! {
        _ = cancellation.cancelled() => return Err(MEDIA_TRANSFER_CANCELLED.into()),
        result = authenticate(&client, app_data_dir, &peer.base_url) => result?,
    };
    let blob = {
        let app_data_dir = app_data_dir.to_path_buf();
        let database_url = peer.database_url.clone();
        let blob_hash = blob_hash.to_string();
        client_blocking(move || {
            crate::media_store::expected_media_blob(&app_data_dir, &database_url, &blob_hash)
        })
        .await?
    };
    let partial_path = crate::media_store::partial_media_blob_path(app_data_dir, &blob)?;
    if let Some(parent) = partial_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let expected_size =
        u64::try_from(blob.byte_size).map_err(|_| "Media object size is invalid".to_string())?;
    let mut downloaded = tokio::fs::metadata(&partial_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if downloaded > expected_size {
        tokio::fs::remove_file(&partial_path)
            .await
            .map_err(|error| error.to_string())?;
        downloaded = 0;
    }
    on_progress(downloaded, expected_size);
    if downloaded < expected_size {
        let path = format!("/v1/sync/blob/{sync_library_id}/{}", blob.blob_hash);
        let mut request = client
            .get(endpoint(&peer.base_url, &path)?)
            .bearer_auth(&session.token);
        if downloaded > 0 {
            request = request.header(RANGE, format!("bytes={downloaded}-"));
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(MEDIA_TRANSFER_CANCELLED.into()),
            result = request.send() => result.map_err(|error| error.to_string())?,
        };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.map_err(|error| error.to_string())?;
            let message = serde_json::from_str::<ApiErrorBody>(&body)
                .map(|error| error.error)
                .unwrap_or(body);
            return Err(format!("LAN server returned {status}: {message}"));
        }
        let resumed = downloaded > 0 && status == StatusCode::PARTIAL_CONTENT;
        if downloaded > 0 && !resumed {
            downloaded = 0;
            on_progress(downloaded, expected_size);
        }
        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&partial_path)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        loop {
            let next_chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(MEDIA_TRANSFER_CANCELLED.into()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = next_chunk else {
                break;
            };
            let chunk = chunk.map_err(|error| error.to_string())?;
            output
                .write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
            downloaded = downloaded.saturating_add(chunk.len() as u64);
            if downloaded > expected_size {
                return Err("LAN server sent more media bytes than expected".into());
            }
            on_progress(downloaded, expected_size);
        }
        output.flush().await.map_err(|error| error.to_string())?;
    }
    if downloaded != expected_size {
        return Err("LAN media transfer ended before the object was complete".into());
    }
    if cancellation.is_cancelled() {
        return Err(MEDIA_TRANSFER_CANCELLED.into());
    }
    let app_data_dir = app_data_dir.to_path_buf();
    let database_url = peer.database_url.clone();
    client_blocking(move || {
        crate::media_store::commit_downloaded_blob(&app_data_dir, &database_url, &blob)
    })
    .await
}

pub async fn download_media_blob(
    app_data_dir: PathBuf,
    sync_library_id: String,
    blob_hash: String,
) -> Result<crate::media_store::MediaBlob, String> {
    let cancellation = CancellationToken::new();
    let mut ignore_progress = |_: u64, _: u64| {};
    download_media_blob_controlled(
        app_data_dir,
        sync_library_id,
        blob_hash,
        &cancellation,
        &mut ignore_progress,
    )
    .await
}

async fn download_media_blob_controlled(
    app_data_dir: PathBuf,
    sync_library_id: String,
    blob_hash: String,
    cancellation: &CancellationToken,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<crate::media_store::MediaBlob, String> {
    let peers = {
        let app_data_dir = app_data_dir.clone();
        let sync_library_id = sync_library_id.clone();
        client_blocking(move || crate::catalog::media_source_peers(&app_data_dir, &sync_library_id))
            .await?
    };
    if peers.is_empty() {
        return Err("No online address is known for a trusted media source".into());
    }
    let mut errors = Vec::new();
    for peer in peers {
        if cancellation.is_cancelled() {
            return Err(MEDIA_TRANSFER_CANCELLED.into());
        }
        match download_blob_from_peer(
            &app_data_dir,
            &peer,
            &sync_library_id,
            &blob_hash,
            cancellation,
            on_progress,
        )
        .await
        {
            Ok(blob) => return Ok(blob),
            Err(error) if error == MEDIA_TRANSFER_CANCELLED => return Err(error),
            Err(error) => errors.push(format!("{}: {error}", peer.device_id)),
        }
    }
    Err(format!(
        "No trusted device could provide this media object ({})",
        errors.join("; ")
    ))
}

pub async fn download_library_media<F>(
    app_data_dir: PathBuf,
    sync_library_id: String,
    transfer_id: String,
    manager: &MediaTransferManager,
    on_progress: F,
) -> Result<MediaTransferReport, String>
where
    F: FnMut(MediaTransferProgress) + Send,
{
    let cancellation = manager.begin(&transfer_id)?;
    let result = download_library_media_inner(
        app_data_dir,
        sync_library_id,
        transfer_id.clone(),
        &cancellation,
        on_progress,
    )
    .await;
    manager.finish(&transfer_id);
    result
}

async fn download_library_media_inner<F>(
    app_data_dir: PathBuf,
    sync_library_id: String,
    transfer_id: String,
    cancellation: &CancellationToken,
    mut on_progress: F,
) -> Result<MediaTransferReport, String>
where
    F: FnMut(MediaTransferProgress) + Send,
{
    let database_url = {
        let app_data_dir = app_data_dir.clone();
        let sync_library_id = sync_library_id.clone();
        client_blocking(move || {
            crate::catalog::library_database_url(&app_data_dir, &sync_library_id)
        })
        .await?
    };
    prepare_local_library(&app_data_dir, &database_url).await?;
    let blobs = {
        let app_data_dir = app_data_dir.clone();
        let database_url = database_url.clone();
        client_blocking(move || {
            crate::media_store::missing_media_blobs(&app_data_dir, &database_url)
        })
        .await?
    };
    let bytes_total = blobs.iter().try_fold(0_u64, |total, blob| {
        let size = u64::try_from(blob.byte_size)
            .map_err(|_| "Media object size is invalid".to_string())?;
        total
            .checked_add(size)
            .ok_or_else(|| "Media transfer size exceeds the supported range".to_string())
    })?;
    let mut completed_by_hash = HashMap::<String, u64>::new();
    for blob in &blobs {
        let expected_size = u64::try_from(blob.byte_size)
            .map_err(|_| "Media object size is invalid".to_string())?;
        let partial_path = crate::media_store::partial_media_blob_path(&app_data_dir, blob)?;
        let partial_size = tokio::fs::metadata(partial_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        completed_by_hash.insert(
            blob.blob_hash.clone(),
            if partial_size <= expected_size {
                partial_size
            } else {
                0
            },
        );
    }
    let files_total = blobs.len();
    let mut files_downloaded = 0;
    let mut files_processed = 0;
    let mut failures = Vec::new();
    on_progress(MediaTransferProgress {
        transfer_id: transfer_id.clone(),
        sync_library_id: sync_library_id.clone(),
        files_total,
        files_processed,
        bytes_total,
        bytes_completed: completed_by_hash.values().copied().sum(),
        current_blob_hash: None,
    });

    for blob in blobs {
        if cancellation.is_cancelled() {
            break;
        }
        let blob_hash = blob.blob_hash.clone();
        let result = download_media_blob_controlled(
            app_data_dir.clone(),
            sync_library_id.clone(),
            blob_hash.clone(),
            cancellation,
            &mut |downloaded, _| {
                completed_by_hash.insert(blob_hash.clone(), downloaded);
                on_progress(MediaTransferProgress {
                    transfer_id: transfer_id.clone(),
                    sync_library_id: sync_library_id.clone(),
                    files_total,
                    files_processed,
                    bytes_total,
                    bytes_completed: completed_by_hash.values().copied().sum(),
                    current_blob_hash: Some(blob_hash.clone()),
                });
            },
        )
        .await;
        match result {
            Ok(_) => {
                completed_by_hash.insert(
                    blob_hash.clone(),
                    u64::try_from(blob.byte_size)
                        .map_err(|_| "Media object size is invalid".to_string())?,
                );
                files_downloaded += 1;
                files_processed += 1;
            }
            Err(error) if error == MEDIA_TRANSFER_CANCELLED => break,
            Err(error) => {
                failures.push(MediaTransferFailure {
                    blob_hash: blob_hash.clone(),
                    error,
                });
                files_processed += 1;
            }
        }
        on_progress(MediaTransferProgress {
            transfer_id: transfer_id.clone(),
            sync_library_id: sync_library_id.clone(),
            files_total,
            files_processed,
            bytes_total,
            bytes_completed: completed_by_hash.values().copied().sum(),
            current_blob_hash: None,
        });
    }

    Ok(MediaTransferReport {
        transfer_id,
        sync_library_id,
        files_total,
        files_downloaded,
        bytes_total,
        bytes_completed: completed_by_hash.values().copied().sum(),
        failures,
        cancelled: cancellation.is_cancelled(),
    })
}

async fn prepare_local_library(app_data_dir: &Path, database_url: &str) -> Result<(), String> {
    let app_data_dir = app_data_dir.to_path_buf();
    let database_url = database_url.to_string();
    client_blocking(move || {
        crate::storage::prepare_graph_database(&app_data_dir, &database_url)?;
        let local_device_id = crate::catalog::local_device_id(&app_data_dir)?;
        crate::sync_store::bootstrap_database(&app_data_dir, &database_url, &local_device_id)
    })
    .await
}

async fn push_library(
    client: &Client,
    app_data_dir: &Path,
    base_url: &str,
    session_token: &str,
    remote_device_id: &str,
    library: &crate::catalog::AuthorizedSyncLibrary,
    report: &mut LanSyncReport,
) -> Result<(), String> {
    loop {
        let batch = {
            let app_data_dir = app_data_dir.to_path_buf();
            let database_url = library.database_url.clone();
            let remote_device_id = remote_device_id.to_string();
            client_blocking(move || {
                let cursor = crate::sync_store::read_peer_cursor(
                    &app_data_dir,
                    &database_url,
                    &remote_device_id,
                    crate::sync_store::PeerCursorKind::Acknowledged,
                )?;
                crate::sync_store::read_sync_changes(
                    &app_data_dir,
                    &database_url,
                    cursor,
                    crate::sync_protocol::MAX_BATCH_CHANGES,
                )
            })
            .await?
        };
        if batch.requires_snapshot {
            let snapshot = {
                let app_data_dir = app_data_dir.to_path_buf();
                let database_url = library.database_url.clone();
                client_blocking(move || {
                    crate::sync_store::read_sync_snapshot(&app_data_dir, &database_url)
                })
                .await?
            };
            let base_cursor = snapshot.base_cursor;
            let result: crate::sync_store::SyncMergeResult = post_json(
                client,
                base_url,
                "/v1/sync/push-snapshot",
                &crate::sync_protocol::PushSnapshotRequest {
                    protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
                    sync_library_id: library.sync_library_id.clone(),
                    snapshot,
                },
                Some(session_token),
            )
            .await?;
            acknowledge_local_push(
                app_data_dir,
                &library.database_url,
                remote_device_id,
                base_cursor,
            )
            .await?;
            report.pushed_snapshots += 1;
            report.conflicts += result.conflicts;
            continue;
        }
        if batch.changes.is_empty() {
            break;
        }
        let change_count = batch.changes.len();
        let next_cursor = batch.next_cursor;
        let has_more = batch.has_more;
        let result: crate::sync_store::SyncMergeResult = post_json(
            client,
            base_url,
            "/v1/sync/push",
            &crate::sync_protocol::PushChangesRequest {
                protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
                sync_library_id: library.sync_library_id.clone(),
                changes: batch.changes,
            },
            Some(session_token),
        )
        .await?;
        acknowledge_local_push(
            app_data_dir,
            &library.database_url,
            remote_device_id,
            next_cursor,
        )
        .await?;
        report.pushed_changes += change_count;
        report.conflicts += result.conflicts;
        if !has_more {
            break;
        }
    }
    Ok(())
}

async fn acknowledge_local_push(
    app_data_dir: &Path,
    database_url: &str,
    remote_device_id: &str,
    sequence: i64,
) -> Result<(), String> {
    let app_data_dir = app_data_dir.to_path_buf();
    let database_url = database_url.to_string();
    let remote_device_id = remote_device_id.to_string();
    client_blocking(move || {
        crate::sync_store::update_peer_cursor(
            &app_data_dir,
            &database_url,
            &remote_device_id,
            crate::sync_store::PeerCursorKind::Acknowledged,
            sequence,
        )?;
        Ok(())
    })
    .await
}

async fn compact_local_sync_journal_best_effort(app_data_dir: &Path, database_url: &str) {
    let app_data_dir = app_data_dir.to_path_buf();
    let database_url = database_url.to_string();
    let _ = client_blocking(move || {
        crate::sync_maintenance::compact_prepared_sync_journal_best_effort(
            &app_data_dir,
            &database_url,
        );
        Ok(())
    })
    .await;
}

async fn pull_library(
    client: &Client,
    app_data_dir: &Path,
    base_url: &str,
    session_token: &str,
    remote_device_id: &str,
    library: &crate::catalog::AuthorizedSyncLibrary,
    report: &mut LanSyncReport,
) -> Result<(), String> {
    loop {
        let pulled_cursor = {
            let app_data_dir = app_data_dir.to_path_buf();
            let database_url = library.database_url.clone();
            let remote_device_id = remote_device_id.to_string();
            client_blocking(move || {
                crate::sync_store::read_peer_cursor(
                    &app_data_dir,
                    &database_url,
                    &remote_device_id,
                    crate::sync_store::PeerCursorKind::Pulled,
                )
            })
            .await?
        };
        let batch: crate::sync_store::SyncBatch = post_json(
            client,
            base_url,
            "/v1/sync/pull",
            &crate::sync_protocol::PullChangesRequest {
                protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
                sync_library_id: library.sync_library_id.clone(),
                after_sequence: pulled_cursor,
                limit: crate::sync_protocol::MAX_BATCH_CHANGES,
            },
            Some(session_token),
        )
        .await?;
        if batch.requires_snapshot {
            let snapshot: crate::sync_store::SyncSnapshot = post_json(
                client,
                base_url,
                "/v1/sync/pull-snapshot",
                &crate::sync_protocol::LibrarySnapshotRequest {
                    protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
                    sync_library_id: library.sync_library_id.clone(),
                },
                Some(session_token),
            )
            .await?;
            let base_cursor = snapshot.base_cursor;
            let result = {
                let app_data_dir = app_data_dir.to_path_buf();
                let database_url = library.database_url.clone();
                let remote_device_id = remote_device_id.to_string();
                client_blocking(move || {
                    crate::sync_store::apply_sync_snapshot(
                        &app_data_dir,
                        &database_url,
                        &remote_device_id,
                        snapshot,
                    )
                })
                .await?
            };
            acknowledge_remote_pull(
                client,
                base_url,
                session_token,
                &library.sync_library_id,
                base_cursor,
            )
            .await?;
            report.pulled_snapshots += 1;
            report.conflicts += result.conflicts;
            continue;
        }
        if batch.changes.is_empty() {
            acknowledge_remote_pull(
                client,
                base_url,
                session_token,
                &library.sync_library_id,
                pulled_cursor,
            )
            .await?;
            break;
        }
        let change_count = batch.changes.len();
        let next_cursor = batch.next_cursor;
        let has_more = batch.has_more;
        let result = {
            let app_data_dir = app_data_dir.to_path_buf();
            let database_url = library.database_url.clone();
            let remote_device_id = remote_device_id.to_string();
            client_blocking(move || {
                crate::sync_store::merge_sync_changes_from_peer(
                    &app_data_dir,
                    &database_url,
                    &remote_device_id,
                    batch.changes,
                )
            })
            .await?
        };
        acknowledge_remote_pull(
            client,
            base_url,
            session_token,
            &library.sync_library_id,
            next_cursor,
        )
        .await?;
        report.pulled_changes += change_count;
        report.conflicts += result.conflicts;
        if !has_more {
            break;
        }
    }
    Ok(())
}

async fn acknowledge_remote_pull(
    client: &Client,
    base_url: &str,
    session_token: &str,
    sync_library_id: &str,
    sequence: i64,
) -> Result<(), String> {
    let _: i64 = post_json(
        client,
        base_url,
        "/v1/sync/ack",
        &crate::sync_protocol::AcknowledgeRequest {
            protocol_major: crate::sync_protocol::PROTOCOL_MAJOR,
            sync_library_id: sync_library_id.to_string(),
            sequence,
        },
        Some(session_token),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn cancels_only_a_registered_media_transfer() {
        let manager = MediaTransferManager::default();
        let transfer_id = Uuid::new_v4().to_string();
        let cancellation = manager.begin(&transfer_id).expect("begin transfer");

        assert!(!cancellation.is_cancelled());
        assert!(manager.cancel(&transfer_id).expect("cancel transfer"));
        assert!(cancellation.is_cancelled());
        manager.finish(&transfer_id);
        assert!(!manager
            .cancel(&transfer_id)
            .expect("cancel finished transfer"));
    }

    #[tokio::test]
    async fn cancels_a_library_media_batch_before_contacting_a_peer() {
        let directory = TestDirectory::new("cancel-media");
        let catalog =
            crate::catalog::load_library_catalog(&directory.0, None).expect("create catalog");
        let library = catalog.libraries.first().expect("default library");
        crate::storage::prepare_graph_database(&directory.0, &library.database_url)
            .expect("prepare graph");
        let connection = directory.graph_connection(&library.database_url);
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
                 ) VALUES (
                    'missing', 'position', 'position-1', 'image', 'Missing', '',
                    ?1, 'image/jpeg', 'jpg', 100
                 )",
                ["a".repeat(64)],
            )
            .expect("insert missing media");
        drop(connection);
        let manager = MediaTransferManager::default();
        let transfer_id = Uuid::new_v4().to_string();
        let cancel_id = transfer_id.clone();

        let report = download_library_media(
            directory.0.clone(),
            library.sync_library_id.clone(),
            transfer_id,
            &manager,
            |_| {
                manager.cancel(&cancel_id).expect("cancel media batch");
            },
        )
        .await
        .expect("cancelled batch report");

        assert_eq!(report.files_total, 1);
        assert_eq!(report.files_downloaded, 0);
        assert!(report.failures.is_empty());
        assert!(report.cancelled);
    }

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("rollmap-lan-{name}-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn graph_connection(&self, database_url: &str) -> Connection {
            let filename =
                crate::storage::database_filename(database_url).expect("read database filename");
            Connection::open(self.0.join(filename)).expect("open graph database")
        }

        fn journal_state(&self, database_url: &str) -> (i64, i64) {
            self.graph_connection(database_url)
                .query_row(
                    "SELECT
                        (SELECT CAST(value AS INTEGER) FROM sync_store_meta
                         WHERE key = 'journal_floor'),
                        (SELECT COUNT(*) FROM sync_journal)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read journal state")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn pairs_and_synchronizes_bidirectionally_over_http() {
        let host = TestDirectory::new("host");
        let peer = TestDirectory::new("peer");
        crate::catalog::load_library_catalog(&host.0, None).expect("load host catalog");
        crate::catalog::load_library_catalog(&peer.0, None).expect("load peer catalog");
        let host_identity =
            crate::identity::device_identity(&host.0).expect("create host identity");
        let peer_identity =
            crate::identity::device_identity(&peer.0).expect("create peer identity");
        let (sync_library_id, host_database_url): (String, String) =
            crate::catalog::open_catalog(&host.0)
                .expect("open host catalog")
                .query_row(
                    "SELECT sync_library_id, database_url FROM libraries WHERE id = 'default'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read host library");
        crate::storage::prepare_graph_database(&host.0, &host_database_url)
            .expect("prepare host graph");
        host.graph_connection(&host_database_url)
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Host guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("seed host graph");
        crate::sync_store::bootstrap_database(
            &host.0,
            &host_database_url,
            &host_identity.device_id,
        )
        .expect("bootstrap host graph");
        fs::create_dir_all(host.0.join("media")).expect("create host media directory");
        let media_bytes = b"rollmap-media-object";
        fs::write(host.0.join("media/guard.jpg"), media_bytes).expect("write host media");
        let host_blob =
            crate::media_store::ingest_media_blob(&host.0, &host_database_url, "media/guard.jpg")
                .expect("ingest host media");
        crate::sync_store::apply_graph_mutation(
            &host.0,
            &host_database_url,
            &host_identity.device_id,
            crate::sync_store::GraphMutation::SaveAttachment {
                attachment: crate::sync_store::Attachment {
                    id: "a1".into(),
                    owner_type: "position".into(),
                    owner_id: "p1".into(),
                    kind: "image".into(),
                    title: "Guard reference".into(),
                    value: host_blob.relative_path.clone(),
                    blob_hash: Some(host_blob.blob_hash.clone()),
                    mime_type: Some(host_blob.mime_type.clone()),
                    file_extension: Some(host_blob.file_extension.clone()),
                    byte_size: Some(host_blob.byte_size),
                },
            },
        )
        .expect("record host media attachment");

        let manager = LanServerManager::default();
        let server = manager
            .start(host.0.clone())
            .await
            .expect("start LAN server");
        let base_url = server
            .base_urls
            .iter()
            .find(|url| url.contains("127.0.0.1"))
            .cloned()
            .expect("read loopback URL");
        let offer = crate::identity::create_pairing_offer(&host.0, "Training Mac")
            .expect("create pairing offer");
        let trusted_host = pair_with_server(
            peer.0.clone(),
            base_url.clone(),
            offer,
            "Pixel 7".into(),
            vec![sync_library_id.clone()],
        )
        .await
        .expect("pair over LAN");
        assert_eq!(trusted_host.device_id, host_identity.device_id);
        assert_eq!(trusted_host.base_url.as_deref(), Some(base_url.as_str()));

        let failing_library_id = "550e8400-e29b-41d4-a716-446655440000";
        let mut host_catalog =
            crate::catalog::load_library_catalog(&host.0, None).expect("reload host catalog");
        host_catalog
            .libraries
            .push(crate::catalog::KnowledgeLibrary {
                id: failing_library_id.into(),
                sync_library_id: failing_library_id.into(),
                name: "New remote library".into(),
                database_url: format!("sqlite:rollmap-library-{failing_library_id}.db"),
                media_directory: format!("media/{failing_library_id}"),
                browser_storage_key: format!("rollmap.graph.library.{failing_library_id}"),
            });
        crate::catalog::save_library_catalog(&host.0, host_catalog)
            .expect("save host library after pairing");
        fs::write(
            peer.0
                .join(format!("rollmap-library-{failing_library_id}.db")),
            b"not a sqlite database",
        )
        .expect("seed broken peer replica");

        let first_report = sync_with_server(
            peer.0.clone(),
            base_url.clone(),
            host_identity.device_id.clone(),
        )
        .await
        .expect("pull host graph");
        assert_eq!(first_report.library_count, 2);
        assert_eq!(first_report.successful_libraries, 1);
        assert_eq!(first_report.failed_libraries.len(), 1);
        assert_eq!(
            first_report.failed_libraries[0].sync_library_id,
            failing_library_id
        );
        assert_eq!(first_report.catalog_changes, 2);
        assert_eq!(first_report.pulled_changes, 3);
        assert!(crate::catalog::load_library_catalog(&peer.0, None)
            .expect("load peer catalog after manifest")
            .libraries
            .iter()
            .any(|library| library.sync_library_id == failing_library_id));
        let peer_database_url = crate::catalog::authorized_library_database_url(
            &peer.0,
            &host_identity.device_id,
            &sync_library_id,
        )
        .expect("resolve peer replica");
        assert_eq!(host.journal_state(&host_database_url), (3, 0));
        assert_eq!(peer.journal_state(&peer_database_url), (0, 3));
        let peer_name: String = peer
            .graph_connection(&peer_database_url)
            .query_row("SELECT name FROM positions WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .expect("read peer position");
        assert_eq!(peer_name, "Host guard");
        let peer_attachment: (String, String) = peer
            .graph_connection(&peer_database_url)
            .query_row(
                "SELECT blob_hash, value FROM attachments WHERE id = 'a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read peer media metadata");
        assert_eq!(peer_attachment.0, host_blob.blob_hash);
        assert!(peer_attachment.1.is_empty());

        let expected_peer_blob = crate::media_store::expected_media_blob(
            &peer.0,
            &peer_database_url,
            &host_blob.blob_hash,
        )
        .expect("read expected peer blob");
        let partial_path =
            crate::media_store::partial_media_blob_path(&peer.0, &expected_peer_blob)
                .expect("resolve partial blob path");
        fs::create_dir_all(partial_path.parent().expect("partial parent"))
            .expect("create partial parent");
        fs::write(&partial_path, &media_bytes[..5]).expect("seed partial media");
        let transfer_manager = MediaTransferManager::default();
        let transfer_id = Uuid::new_v4().to_string();
        let mut transfer_progress = Vec::new();
        let transfer_report = download_library_media(
            peer.0.clone(),
            sync_library_id.clone(),
            transfer_id.clone(),
            &transfer_manager,
            |progress| transfer_progress.push(progress),
        )
        .await
        .expect("resume library media download");
        assert_eq!(transfer_report.transfer_id, transfer_id);
        assert_eq!(transfer_report.files_total, 1);
        assert_eq!(transfer_report.files_downloaded, 1);
        assert_eq!(transfer_report.bytes_total, media_bytes.len() as u64);
        assert_eq!(transfer_report.bytes_completed, media_bytes.len() as u64);
        assert!(transfer_report.failures.is_empty());
        assert!(!transfer_report.cancelled);
        assert!(transfer_progress.iter().any(|progress| {
            progress.current_blob_hash.as_deref() == Some(&host_blob.blob_hash)
                && progress.bytes_completed >= 5
        }));
        assert_eq!(
            fs::read(peer.0.join(&expected_peer_blob.relative_path))
                .expect("read downloaded media"),
            media_bytes
        );

        let peer_update = crate::sync_store::SyncChange {
            sequence: 1,
            change_id: Uuid::new_v4().to_string(),
            entity_type: crate::sync_store::SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: crate::sync_store::SyncOperation::Upsert,
            generation: 0,
            hlc: crate::sync_store::HybridTimestamp {
                physical_ms: i64::MAX / 4,
                logical_counter: 0,
            },
            origin_device_id: peer_identity.device_id.clone(),
            payload: Some(json!({
                "id": "p1",
                "name": "Peer guard",
                "aliases": [],
                "description": "",
                "category": "guard",
                "role": "bottom",
                "tags": []
            })),
        };
        crate::sync_store::merge_sync_changes(&peer.0, &peer_database_url, vec![peer_update])
            .expect("record peer update");

        let second_report = sync_with_server(
            peer.0.clone(),
            base_url.clone(),
            host_identity.device_id.clone(),
        )
        .await
        .expect("push peer graph");
        assert_eq!(second_report.pushed_changes, 4);
        assert_eq!(host.journal_state(&host_database_url), (4, 0));
        assert_eq!(peer.journal_state(&peer_database_url), (4, 0));
        let host_name: String = host
            .graph_connection(&host_database_url)
            .query_row("SELECT name FROM positions WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .expect("read host position");
        assert_eq!(host_name, "Peer guard");
        let host_update = crate::sync_store::SyncChange {
            sequence: 1,
            change_id: Uuid::new_v4().to_string(),
            entity_type: crate::sync_store::SyncEntityType::Position,
            entity_id: "p1".into(),
            operation: crate::sync_store::SyncOperation::Upsert,
            generation: 0,
            hlc: crate::sync_store::HybridTimestamp {
                physical_ms: i64::MAX / 3,
                logical_counter: 0,
            },
            origin_device_id: host_identity.device_id.clone(),
            payload: Some(json!({
                "id": "p1",
                "name": "Host follow-up",
                "aliases": [],
                "description": "",
                "category": "guard",
                "role": "bottom",
                "tags": []
            })),
        };
        crate::sync_store::merge_sync_changes(&host.0, &host_database_url, vec![host_update])
            .expect("record host follow-up");
        let lost_ack_batch =
            crate::sync_store::read_sync_changes(&host.0, &host_database_url, 4, 500)
                .expect("read unacknowledged host change");
        assert_eq!(lost_ack_batch.next_cursor, 5);
        assert_eq!(lost_ack_batch.changes.len(), 1);
        crate::sync_store::merge_sync_changes_from_peer(
            &peer.0,
            &peer_database_url,
            &host_identity.device_id,
            lost_ack_batch.changes,
        )
        .expect("apply host change without remote acknowledgement");
        assert_eq!(host.journal_state(&host_database_url), (4, 1));

        let retry_report =
            sync_with_server(peer.0.clone(), base_url, host_identity.device_id.clone())
                .await
                .expect("retry lost acknowledgement with an empty pull");
        assert_eq!(retry_report.pushed_changes, 1);
        assert_eq!(retry_report.pulled_changes, 0);
        assert_eq!(host.journal_state(&host_database_url), (5, 0));
        assert_eq!(peer.journal_state(&peer_database_url), (5, 0));
        assert!(crate::identity::verify_trusted_peer_signature(
            &host.0,
            &peer_identity.device_id,
            &crate::identity::generate_authentication_challenge(),
            "invalid",
        )
        .is_err());
        assert!(manager.stop().await.expect("stop LAN server"));
        assert!(manager.status().await.is_none());
    }
}
