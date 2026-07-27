use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const DEVICE_SIGNING_KEY_META: &str = "test_device_signing_key";
const PAIRING_PROTOCOL_MAJOR: u32 = crate::sync_protocol::PROTOCOL_MAJOR;
const PAIRING_TOKEN_BYTES: usize = 16;
const PAIRING_TOKEN_TTL_MS: i64 = 5 * 60 * 1_000;
const MAX_CHALLENGE_BYTES: usize = 1_024;
const MIN_CHALLENGE_BYTES: usize = 16;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub(crate) device_id: String,
    pub(crate) identity_public_key: String,
    pub(crate) fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLibrary {
    pub(crate) sync_library_id: String,
    pub(crate) name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingOffer {
    pub(crate) protocol_major: u32,
    pub(crate) device_id: String,
    pub(crate) display_name: String,
    pub(crate) identity_public_key: String,
    pub(crate) fingerprint: String,
    pub(crate) token: String,
    pub(crate) expires_at_ms: i64,
    pub(crate) libraries: Vec<PairingLibrary>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    protocol_major: u32,
    token: String,
    host_device_id: String,
    peer_device_id: String,
    peer_display_name: String,
    peer_identity_public_key: String,
    sync_library_ids: Vec<String>,
    signature: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPeer {
    pub(crate) device_id: String,
    pub(crate) display_name: String,
    pub(crate) identity_public_key: String,
    pub(crate) fingerprint: String,
    pub(crate) sync_library_ids: Vec<String>,
    pub(crate) trusted_at: String,
    pub(crate) revoked: bool,
    pub(crate) base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingProof<'a> {
    protocol_major: u32,
    token: &'a str,
    host_device_id: &'a str,
    peer_device_id: &'a str,
    peer_display_name: &'a str,
    peer_identity_public_key: &'a str,
    sync_library_ids: &'a [String],
}

fn current_time_ms() -> Result<i64, String> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(milliseconds).map_err(|_| "System time is outside SQLite's range".into())
}

fn validate_display_name(display_name: &str) -> Result<String, String> {
    let trimmed = display_name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 {
        return Err("Device name must contain between 1 and 120 characters".into());
    }
    Ok(trimmed.to_string())
}

fn decode_fixed<const LENGTH: usize>(encoded: &str, label: &str) -> Result<[u8; LENGTH], String> {
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| format!("{label} is not valid base64"))?;
    decoded
        .try_into()
        .map_err(|_| format!("{label} must contain {LENGTH} bytes"))
}

fn decode_verifying_key(encoded: &str) -> Result<VerifyingKey, String> {
    let bytes = decode_fixed::<32>(encoded, "Identity public key")?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "Identity public key is invalid".into())
}

fn fingerprint(public_key: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
}

fn pairing_token_hash(token: &str) -> Result<[u8; 32], String> {
    let token_bytes = URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| "Pairing token is not valid base64".to_string())?;
    if token_bytes.len() != PAIRING_TOKEN_BYTES {
        return Err("Pairing token has an invalid length".into());
    }
    Ok(Sha256::digest(token_bytes).into())
}

fn normalize_sync_library_ids(sync_library_ids: &[String]) -> Result<Vec<String>, String> {
    if sync_library_ids.is_empty() {
        return Err("Pairing must authorize at least one knowledge library".into());
    }
    let mut normalized = BTreeSet::new();
    for sync_library_id in sync_library_ids {
        Uuid::parse_str(sync_library_id)
            .map_err(|_| "Library sync identity must be a UUID".to_string())?;
        normalized.insert(sync_library_id.clone());
    }
    Ok(normalized.into_iter().collect())
}

fn pairing_proof_bytes(request: &PairingRequest) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&PairingProof {
        protocol_major: request.protocol_major,
        token: &request.token,
        host_device_id: &request.host_device_id,
        peer_device_id: &request.peer_device_id,
        peer_display_name: &request.peer_display_name,
        peer_identity_public_key: &request.peer_identity_public_key,
        sync_library_ids: &request.sync_library_ids,
    })
    .map_err(|error| error.to_string())
}

fn signing_key(app_data_dir: &Path) -> Result<SigningKey, String> {
    let connection = crate::catalog::open_catalog(app_data_dir)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = ?1",
            [DEVICE_SIGNING_KEY_META],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(stored) = stored {
        return Ok(SigningKey::from_bytes(&decode_fixed::<32>(
            &stored,
            "Device signing key",
        )?));
    }

    // Test-stage backend: replace this catalog value with Keychain/Keystore before release.
    let generated = SigningKey::generate(&mut OsRng);
    let encoded = STANDARD.encode(generated.to_bytes());
    connection
        .execute(
            "INSERT OR IGNORE INTO catalog_meta (key, value) VALUES (?1, ?2)",
            params![DEVICE_SIGNING_KEY_META, encoded],
        )
        .map_err(|error| error.to_string())?;
    let persisted: String = connection
        .query_row(
            "SELECT value FROM catalog_meta WHERE key = ?1",
            [DEVICE_SIGNING_KEY_META],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(SigningKey::from_bytes(&decode_fixed::<32>(
        &persisted,
        "Device signing key",
    )?))
}

pub fn device_identity(app_data_dir: &Path) -> Result<DeviceIdentity, String> {
    let device_id = crate::catalog::local_device_id(app_data_dir)?;
    let signing_key = signing_key(app_data_dir)?;
    let public_key = signing_key.verifying_key().to_bytes();
    Ok(DeviceIdentity {
        device_id,
        identity_public_key: STANDARD.encode(public_key),
        fingerprint: fingerprint(&public_key),
    })
}

fn validate_pairing_offer(offer: &PairingOffer, now_ms: i64) -> Result<VerifyingKey, String> {
    if offer.protocol_major != PAIRING_PROTOCOL_MAJOR {
        return Err("Pairing protocol version is not supported".into());
    }
    Uuid::parse_str(&offer.device_id)
        .map_err(|_| "Pairing host identity must be a UUID".to_string())?;
    validate_display_name(&offer.display_name)?;
    pairing_token_hash(&offer.token)?;
    if offer.expires_at_ms < now_ms {
        return Err("Pairing offer has expired".into());
    }
    let verifying_key = decode_verifying_key(&offer.identity_public_key)?;
    if fingerprint(&verifying_key.to_bytes()) != offer.fingerprint {
        return Err("Pairing offer fingerprint does not match its public key".into());
    }
    let offered_ids = offer
        .libraries
        .iter()
        .map(|library| library.sync_library_id.clone())
        .collect::<Vec<_>>();
    let normalized = normalize_sync_library_ids(&offered_ids)?;
    if normalized.len() != offered_ids.len() {
        return Err("Pairing offer contains duplicate knowledge libraries".into());
    }
    for library in &offer.libraries {
        if library.name.trim().is_empty() || library.name.chars().count() > 120 {
            return Err("Pairing library name is invalid".into());
        }
    }
    Ok(verifying_key)
}

pub fn create_pairing_offer(
    app_data_dir: &Path,
    display_name: &str,
) -> Result<PairingOffer, String> {
    let display_name = validate_display_name(display_name)?;
    let identity = device_identity(app_data_dir)?;
    let mut token_bytes = [0_u8; PAIRING_TOKEN_BYTES];
    OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = pairing_token_hash(&token)?;
    let now_ms = current_time_ms()?;
    let expires_at_ms = now_ms
        .checked_add(PAIRING_TOKEN_TTL_MS)
        .ok_or_else(|| "Pairing expiration overflowed".to_string())?;
    let mut connection = crate::catalog::open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM pairing_sessions
             WHERE expires_at_ms < ?1",
            [now_ms - PAIRING_TOKEN_TTL_MS],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO pairing_sessions (token_hash, expires_at_ms) VALUES (?1, ?2)",
            params![token_hash.as_slice(), expires_at_ms],
        )
        .map_err(|error| error.to_string())?;
    let libraries = {
        let mut statement = transaction
            .prepare(
                "SELECT sync_library_id, name FROM libraries
                 WHERE deleted_at IS NULL ORDER BY name, sync_library_id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| {
                Ok(PairingLibrary {
                    sync_library_id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    if libraries.is_empty() {
        return Err("No knowledge libraries are available for pairing".into());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(PairingOffer {
        protocol_major: PAIRING_PROTOCOL_MAJOR,
        device_id: identity.device_id,
        display_name,
        identity_public_key: identity.identity_public_key,
        fingerprint: identity.fingerprint,
        token,
        expires_at_ms,
        libraries,
    })
}

pub fn create_pairing_request(
    app_data_dir: &Path,
    offer: PairingOffer,
    peer_display_name: &str,
    sync_library_ids: Vec<String>,
) -> Result<PairingRequest, String> {
    validate_pairing_offer(&offer, current_time_ms()?)?;
    let peer_display_name = validate_display_name(peer_display_name)?;
    let sync_library_ids = normalize_sync_library_ids(&sync_library_ids)?;
    let offered_ids = offer
        .libraries
        .iter()
        .map(|library| library.sync_library_id.as_str())
        .collect::<BTreeSet<_>>();
    if sync_library_ids
        .iter()
        .any(|sync_library_id| !offered_ids.contains(sync_library_id.as_str()))
    {
        return Err("Pairing requested a library that the host did not offer".into());
    }
    let identity = device_identity(app_data_dir)?;
    if identity.device_id == offer.device_id {
        return Err("A device cannot pair with itself".into());
    }
    let signing_key = signing_key(app_data_dir)?;
    let mut request = PairingRequest {
        protocol_major: PAIRING_PROTOCOL_MAJOR,
        token: offer.token,
        host_device_id: offer.device_id,
        peer_device_id: identity.device_id,
        peer_display_name,
        peer_identity_public_key: identity.identity_public_key,
        sync_library_ids,
        signature: String::new(),
    };
    request.signature =
        STANDARD.encode(signing_key.sign(&pairing_proof_bytes(&request)?).to_bytes());
    Ok(request)
}

fn verify_pairing_request(request: &PairingRequest) -> Result<Vec<u8>, String> {
    if request.protocol_major != PAIRING_PROTOCOL_MAJOR {
        return Err("Pairing protocol version is not supported".into());
    }
    Uuid::parse_str(&request.host_device_id)
        .map_err(|_| "Pairing host identity must be a UUID".to_string())?;
    Uuid::parse_str(&request.peer_device_id)
        .map_err(|_| "Pairing peer identity must be a UUID".to_string())?;
    if request.host_device_id == request.peer_device_id {
        return Err("A device cannot pair with itself".into());
    }
    let trimmed_name = validate_display_name(&request.peer_display_name)?;
    if trimmed_name != request.peer_display_name {
        return Err("Pairing peer name must already be normalized".into());
    }
    pairing_token_hash(&request.token)?;
    let normalized_ids = normalize_sync_library_ids(&request.sync_library_ids)?;
    if normalized_ids != request.sync_library_ids {
        return Err("Pairing library identities must be unique and sorted".into());
    }
    let verifying_key = decode_verifying_key(&request.peer_identity_public_key)?;
    let signature_bytes = decode_fixed::<64>(&request.signature, "Pairing signature")?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify_strict(&pairing_proof_bytes(request)?, &signature)
        .map_err(|_| "Pairing request signature is invalid".to_string())?;
    Ok(verifying_key.to_bytes().to_vec())
}

fn upsert_trusted_peer(
    transaction: &Transaction<'_>,
    device_id: &str,
    display_name: &str,
    public_key: &[u8],
) -> Result<(), String> {
    let existing_key: Option<Vec<u8>> = transaction
        .query_row(
            "SELECT identity_public_key FROM trusted_peers WHERE device_id = ?1",
            [device_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing_key
        .as_ref()
        .is_some_and(|existing| existing.as_slice() != public_key)
    {
        return Err("Trusted peer identity key cannot be replaced".into());
    }
    transaction
        .execute(
            "INSERT INTO trusted_peers (device_id, display_name, identity_public_key)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(device_id) DO UPDATE SET
                display_name = excluded.display_name,
                revoked_at = NULL",
            params![device_id, display_name, public_key],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_replica_library(
    transaction: &Transaction<'_>,
    library: &PairingLibrary,
) -> Result<(), String> {
    Uuid::parse_str(&library.sync_library_id)
        .map_err(|_| "Library sync identity must be a UUID".to_string())?;
    let name = library.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("Pairing library name is invalid".into());
    }
    let existing: Option<String> = transaction
        .query_row(
            "SELECT id FROM libraries WHERE sync_library_id = ?1",
            [&library.sync_library_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.is_some() {
        transaction
            .execute(
                "UPDATE libraries SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE sync_library_id = ?1",
                [&library.sync_library_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let id = &library.sync_library_id;
    transaction
        .execute(
            "INSERT INTO libraries (
                id, sync_library_id, name, database_url, media_directory, browser_storage_key
             ) VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                name,
                format!("sqlite:rollmap-library-{id}.db"),
                format!("media/{id}"),
                format!("rollmap.graph.library.{id}"),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn read_trusted_peer(connection: &Connection, device_id: &str) -> Result<TrustedPeer, String> {
    let (display_name, public_key, trusted_at, revoked, base_url): (
        String,
        Vec<u8>,
        String,
        bool,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT peers.display_name, peers.identity_public_key, peers.trusted_at,
                    peers.revoked_at IS NOT NULL, endpoints.base_url
             FROM trusted_peers AS peers
             LEFT JOIN trusted_peer_endpoints AS endpoints
               ON endpoints.peer_device_id = peers.device_id
             WHERE peers.device_id = ?1",
            [device_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| "Stored peer identity public key is invalid".to_string())?;
    let sync_library_ids = {
        let mut statement = connection
            .prepare(
                "SELECT sync_library_id FROM trusted_peer_libraries
                 WHERE peer_device_id = ?1 AND revoked_at IS NULL
                 ORDER BY sync_library_id",
            )
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([device_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    Ok(TrustedPeer {
        device_id: device_id.to_string(),
        display_name,
        identity_public_key: STANDARD.encode(public_key),
        fingerprint: fingerprint(&public_key),
        sync_library_ids,
        trusted_at,
        revoked,
        base_url,
    })
}

pub fn complete_pairing(
    app_data_dir: &Path,
    request: PairingRequest,
) -> Result<TrustedPeer, String> {
    let public_key = verify_pairing_request(&request)?;
    let local_device_id = crate::catalog::local_device_id(app_data_dir)?;
    if request.host_device_id != local_device_id {
        return Err("Pairing request was issued for a different host".into());
    }
    let token_hash = pairing_token_hash(&request.token)?;
    let now_ms = current_time_ms()?;
    let mut connection = crate::catalog::open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let session: Option<(i64, Option<i64>)> = transaction
        .query_row(
            "SELECT expires_at_ms, consumed_at_ms FROM pairing_sessions WHERE token_hash = ?1",
            [token_hash.as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (expires_at_ms, consumed_at_ms) =
        session.ok_or_else(|| "Pairing token is unknown".to_string())?;
    if consumed_at_ms.is_some() {
        return Err("Pairing token has already been used".into());
    }
    if expires_at_ms < now_ms {
        return Err("Pairing token has expired".into());
    }
    for sync_library_id in &request.sync_library_ids {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM libraries
                    WHERE sync_library_id = ?1 AND deleted_at IS NULL
                 )",
                [sync_library_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("Pairing requested an unavailable knowledge library".into());
        }
    }
    upsert_trusted_peer(
        &transaction,
        &request.peer_device_id,
        &request.peer_display_name,
        &public_key,
    )?;
    transaction
        .execute(
            "UPDATE trusted_peer_libraries
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE peer_device_id = ?1 AND revoked_at IS NULL",
            [&request.peer_device_id],
        )
        .map_err(|error| error.to_string())?;
    for sync_library_id in &request.sync_library_ids {
        transaction
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 VALUES (?1, ?2)
                 ON CONFLICT(peer_device_id, sync_library_id) DO UPDATE SET
                    authorized_at = CURRENT_TIMESTAMP,
                    revoked_at = NULL",
                params![request.peer_device_id, sync_library_id],
            )
            .map_err(|error| error.to_string())?;
    }
    let consumed = transaction
        .execute(
            "UPDATE pairing_sessions SET consumed_at_ms = ?2
             WHERE token_hash = ?1 AND consumed_at_ms IS NULL",
            params![token_hash.as_slice(), now_ms],
        )
        .map_err(|error| error.to_string())?;
    if consumed != 1 {
        return Err("Pairing token could not be consumed".into());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    crate::sync_maintenance::compact_all_existing_sync_journals_best_effort(app_data_dir);
    read_trusted_peer(&connection, &request.peer_device_id)
}

pub fn trust_pairing_offer(
    app_data_dir: &Path,
    offer: PairingOffer,
    sync_library_ids: Vec<String>,
) -> Result<TrustedPeer, String> {
    let verifying_key = validate_pairing_offer(&offer, current_time_ms()?)?;
    let sync_library_ids = normalize_sync_library_ids(&sync_library_ids)?;
    let offered_libraries = offer
        .libraries
        .iter()
        .map(|library| (library.sync_library_id.as_str(), library))
        .collect::<std::collections::BTreeMap<_, _>>();
    if sync_library_ids
        .iter()
        .any(|sync_library_id| !offered_libraries.contains_key(sync_library_id.as_str()))
    {
        return Err("Pairing selected a library that the host did not offer".into());
    }
    let local_device_id = crate::catalog::local_device_id(app_data_dir)?;
    if offer.device_id == local_device_id {
        return Err("A device cannot trust itself as a peer".into());
    }
    let mut connection = crate::catalog::open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    upsert_trusted_peer(
        &transaction,
        &offer.device_id,
        &offer.display_name,
        &verifying_key.to_bytes(),
    )?;
    transaction
        .execute(
            "UPDATE trusted_peer_libraries
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE peer_device_id = ?1 AND revoked_at IS NULL",
            [&offer.device_id],
        )
        .map_err(|error| error.to_string())?;
    for sync_library_id in &sync_library_ids {
        let library = offered_libraries
            .get(sync_library_id.as_str())
            .ok_or_else(|| "Pairing library disappeared from the offer".to_string())?;
        ensure_replica_library(&transaction, library)?;
        transaction
            .execute(
                "INSERT INTO trusted_peer_libraries (peer_device_id, sync_library_id)
                 VALUES (?1, ?2)
                 ON CONFLICT(peer_device_id, sync_library_id) DO UPDATE SET
                    authorized_at = CURRENT_TIMESTAMP,
                    revoked_at = NULL",
                params![offer.device_id, sync_library_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    crate::sync_maintenance::compact_all_existing_sync_journals_best_effort(app_data_dir);
    read_trusted_peer(&connection, &offer.device_id)
}

pub fn list_trusted_peers(app_data_dir: &Path) -> Result<Vec<TrustedPeer>, String> {
    let connection = crate::catalog::open_catalog(app_data_dir)?;
    let peer_ids = {
        let mut statement = connection
            .prepare("SELECT device_id FROM trusted_peers ORDER BY trusted_at, device_id")
            .map_err(|error| error.to_string())?;
        let collected = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        collected
    };
    peer_ids
        .iter()
        .map(|peer_id| read_trusted_peer(&connection, peer_id))
        .collect()
}

pub fn rename_trusted_peer(
    app_data_dir: &Path,
    peer_device_id: &str,
    display_name: &str,
) -> Result<TrustedPeer, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let display_name = validate_display_name(display_name)?;
    let connection = crate::catalog::open_catalog(app_data_dir)?;
    let updated = connection
        .execute(
            "UPDATE trusted_peers SET display_name = ?2 WHERE device_id = ?1",
            params![peer_device_id, display_name],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("Trusted peer does not exist".into());
    }
    read_trusted_peer(&connection, peer_device_id)
}

pub fn revoke_trusted_peer(app_data_dir: &Path, peer_device_id: &str) -> Result<bool, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let mut connection = crate::catalog::open_catalog(app_data_dir)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let updated = transaction
        .execute(
            "UPDATE trusted_peers SET revoked_at = CURRENT_TIMESTAMP
             WHERE device_id = ?1 AND revoked_at IS NULL",
            [peer_device_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE trusted_peer_libraries SET revoked_at = CURRENT_TIMESTAMP
             WHERE peer_device_id = ?1 AND revoked_at IS NULL",
            [peer_device_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let revoked = updated == 1;
    if revoked {
        crate::sync_maintenance::compact_all_existing_sync_journals_best_effort(app_data_dir);
    }
    Ok(revoked)
}

fn decode_challenge(challenge: &str) -> Result<Vec<u8>, String> {
    let challenge = URL_SAFE_NO_PAD
        .decode(challenge)
        .map_err(|_| "Authentication challenge is not valid base64".to_string())?;
    if !(MIN_CHALLENGE_BYTES..=MAX_CHALLENGE_BYTES).contains(&challenge.len()) {
        return Err(format!(
            "Authentication challenge must contain between {MIN_CHALLENGE_BYTES} and {MAX_CHALLENGE_BYTES} bytes"
        ));
    }
    Ok(challenge)
}

pub fn generate_authentication_challenge() -> String {
    let mut challenge = [0_u8; 32];
    OsRng.fill_bytes(&mut challenge);
    URL_SAFE_NO_PAD.encode(challenge)
}

pub fn sign_authentication_challenge(
    app_data_dir: &Path,
    challenge: &str,
) -> Result<String, String> {
    let challenge = decode_challenge(challenge)?;
    Ok(STANDARD.encode(signing_key(app_data_dir)?.sign(&challenge).to_bytes()))
}

pub fn verify_trusted_peer_signature(
    app_data_dir: &Path,
    peer_device_id: &str,
    challenge: &str,
    signature: &str,
) -> Result<bool, String> {
    Uuid::parse_str(peer_device_id)
        .map_err(|_| "Peer device identity must be a UUID".to_string())?;
    let challenge = decode_challenge(challenge)?;
    let signature = Signature::from_bytes(&decode_fixed::<64>(signature, "Peer signature")?);
    let connection = crate::catalog::open_catalog(app_data_dir)?;
    let public_key: Option<Vec<u8>> = connection
        .query_row(
            "SELECT identity_public_key FROM trusted_peers
             WHERE device_id = ?1 AND revoked_at IS NULL",
            [peer_device_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(public_key) = public_key else {
        return Ok(false);
    };
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| "Stored peer identity public key is invalid".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "Stored peer identity public key is invalid".to_string())?;
    Ok(verifying_key.verify_strict(&challenge, &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "rollmap-identity-{name}-{}-{id}",
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

    fn prepare(directory: &TestDirectory) -> crate::catalog::LibraryCatalog {
        crate::catalog::load_library_catalog(&directory.0, None).expect("load catalog")
    }

    #[test]
    fn pairs_two_devices_once_and_authenticates_the_trusted_peer() {
        let host = TestDirectory::new("host");
        let peer = TestDirectory::new("peer");
        prepare(&host);
        prepare(&peer);
        let host_identity = device_identity(&host.0).expect("create host identity");
        assert_eq!(
            device_identity(&host.0).expect("reload host identity"),
            host_identity
        );
        let offer = create_pairing_offer(&host.0, "Training Mac").expect("create offer");
        let sync_library_id = offer.libraries[0].sync_library_id.clone();
        let request = create_pairing_request(
            &peer.0,
            offer.clone(),
            "Pixel 7",
            vec![sync_library_id.clone()],
        )
        .expect("create request");
        let mut tampered_request = request.clone();
        tampered_request.peer_display_name = "Altered phone".into();
        assert!(complete_pairing(&host.0, tampered_request)
            .expect_err("reject tampered request")
            .contains("signature is invalid"));
        assert!(list_trusted_peers(&host.0)
            .expect("list peers after tampering")
            .is_empty());
        let paired = complete_pairing(&host.0, request.clone()).expect("complete pairing");
        assert_eq!(paired.device_id, request.peer_device_id);
        assert_eq!(paired.display_name, "Pixel 7");
        assert_eq!(paired.sync_library_ids, request.sync_library_ids);
        assert!(!paired.revoked);
        assert!(complete_pairing(&host.0, request)
            .expect_err("reject token reuse")
            .contains("already been used"));

        let trusted_host = trust_pairing_offer(&peer.0, offer, vec![sync_library_id.clone()])
            .expect("trust host offer");
        assert_eq!(trusted_host.device_id, host_identity.device_id);
        assert_eq!(trusted_host.sync_library_ids, vec![sync_library_id.clone()]);
        assert_eq!(
            crate::catalog::authorized_library_database_url(
                &peer.0,
                &host_identity.device_id,
                &sync_library_id,
            )
            .expect("resolve replica library"),
            format!("sqlite:rollmap-library-{sync_library_id}.db")
        );
        let challenge = generate_authentication_challenge();
        let signature = sign_authentication_challenge(&peer.0, &challenge).expect("sign challenge");
        assert!(
            verify_trusted_peer_signature(&host.0, &paired.device_id, &challenge, &signature,)
                .expect("verify challenge")
        );
        let other_challenge = generate_authentication_challenge();
        assert!(!verify_trusted_peer_signature(
            &host.0,
            &paired.device_id,
            &other_challenge,
            &signature,
        )
        .expect("reject mismatched challenge"));
        assert_eq!(
            crate::catalog::required_sync_peer_ids(&host.0, "sqlite:rollmap.db")
                .expect("read required peers"),
            vec![paired.device_id.clone()]
        );
        crate::storage::prepare_graph_database(&host.0, "sqlite:rollmap.db")
            .expect("prepare host graph");
        let graph_connection =
            rusqlite::Connection::open(host.0.join("rollmap.db")).expect("open host graph");
        graph_connection
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("seed host graph");
        drop(graph_connection);
        crate::sync_store::bootstrap_database(
            &host.0,
            "sqlite:rollmap.db",
            &host_identity.device_id,
        )
        .expect("bootstrap host graph");
        assert_eq!(
            crate::sync_store::read_sync_changes(&host.0, "sqlite:rollmap.db", 0, 500)
                .expect("read blocked journal")
                .changes
                .len(),
            2
        );

        let renamed =
            rename_trusted_peer(&host.0, &paired.device_id, "Mat phone").expect("rename peer");
        assert_eq!(renamed.display_name, "Mat phone");
        assert!(revoke_trusted_peer(&host.0, &paired.device_id).expect("revoke peer"));
        let compacted = crate::sync_store::read_sync_changes(&host.0, "sqlite:rollmap.db", 0, 500)
            .expect("read compacted journal");
        assert!(compacted.requires_snapshot);
        assert_eq!(compacted.journal_floor, 2);
        assert!(compacted.changes.is_empty());
        assert!(
            !verify_trusted_peer_signature(&host.0, &paired.device_id, &challenge, &signature,)
                .expect("reject revoked peer")
        );
        assert!(
            crate::catalog::required_sync_peer_ids(&host.0, "sqlite:rollmap.db")
                .expect("read peers after revocation")
                .is_empty()
        );
        assert!(list_trusted_peers(&host.0).expect("list peers")[0].revoked);
    }

    #[test]
    fn repairing_with_fewer_libraries_compacts_released_journals() {
        let host = TestDirectory::new("repair-host");
        let peer = TestDirectory::new("repair-peer");
        let mut host_catalog = prepare(&host);
        prepare(&peer);
        let host_identity = device_identity(&host.0).expect("create host identity");
        let default_library_id = host_catalog.libraries[0].sync_library_id.clone();
        let released_library_id = "84ef9237-307d-45c7-b5c2-121d5e24bc3f";
        let released_database_url = format!("sqlite:rollmap-library-{released_library_id}.db");
        host_catalog
            .libraries
            .push(crate::catalog::KnowledgeLibrary {
                id: released_library_id.into(),
                sync_library_id: released_library_id.into(),
                name: "Released library".into(),
                database_url: released_database_url.clone(),
                media_directory: format!("media/{released_library_id}"),
                browser_storage_key: format!("rollmap.graph.library.{released_library_id}"),
            });
        crate::catalog::save_library_catalog(&host.0, host_catalog)
            .expect("save second host library");

        let first_offer = create_pairing_offer(&host.0, "Training Mac").expect("create offer");
        let first_request = create_pairing_request(
            &peer.0,
            first_offer,
            "Pixel 7",
            vec![default_library_id.clone(), released_library_id.into()],
        )
        .expect("create initial request");
        let peer_device_id = first_request.peer_device_id.clone();
        complete_pairing(&host.0, first_request).expect("complete initial pairing");

        crate::storage::prepare_graph_database(&host.0, &released_database_url)
            .expect("prepare released graph");
        let released_filename =
            crate::storage::database_filename(&released_database_url).expect("database filename");
        let graph_connection = rusqlite::Connection::open(host.0.join(released_filename))
            .expect("open released graph");
        graph_connection
            .execute(
                "INSERT INTO positions (id, name, category, role, x, y)
                 VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0)",
                [],
            )
            .expect("seed released graph");
        drop(graph_connection);
        crate::sync_store::bootstrap_database(
            &host.0,
            &released_database_url,
            &host_identity.device_id,
        )
        .expect("bootstrap released graph");
        assert_eq!(
            crate::sync_store::read_sync_changes(&host.0, &released_database_url, 0, 500)
                .expect("read blocked released journal")
                .changes
                .len(),
            2
        );

        let second_offer = create_pairing_offer(&host.0, "Training Mac").expect("renew offer");
        let second_request = create_pairing_request(
            &peer.0,
            second_offer,
            "Pixel 7",
            vec![default_library_id.clone()],
        )
        .expect("create reduced request");
        assert_eq!(second_request.peer_device_id, peer_device_id);
        let repaired = complete_pairing(&host.0, second_request).expect("complete reduced pairing");
        assert_eq!(repaired.sync_library_ids, vec![default_library_id]);

        let compacted =
            crate::sync_store::read_sync_changes(&host.0, &released_database_url, 0, 500)
                .expect("read released compacted journal");
        assert!(compacted.requires_snapshot);
        assert_eq!(compacted.journal_floor, 2);
        assert!(compacted.changes.is_empty());
    }

    #[test]
    fn rejects_an_expired_pairing_session_without_trusting_the_peer() {
        let host = TestDirectory::new("expired-host");
        let peer = TestDirectory::new("expired-peer");
        prepare(&host);
        prepare(&peer);
        let offer = create_pairing_offer(&host.0, "Training Mac").expect("create offer");
        let sync_library_id = offer.libraries[0].sync_library_id.clone();
        let request = create_pairing_request(&peer.0, offer, "Pixel 7", vec![sync_library_id])
            .expect("create request");
        crate::catalog::open_catalog(&host.0)
            .expect("open host catalog")
            .execute(
                "UPDATE pairing_sessions SET expires_at_ms = ?1",
                [current_time_ms().expect("current time") - 1],
            )
            .expect("expire session");

        assert!(complete_pairing(&host.0, request)
            .expect_err("reject expired token")
            .contains("expired"));
        assert!(list_trusted_peers(&host.0)
            .expect("list host peers")
            .is_empty());
    }
}
