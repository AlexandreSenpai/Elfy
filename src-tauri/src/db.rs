use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const DB_FILE_NAME: &str = "elfy.sqlite";
const DEFAULT_FPS: u32 = 60;
const FALLBACK_FPS: u32 = 30;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5000;
const VALID_CONSENT_VALUES: [&str; 3] = ["unset", "granted", "denied"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRowDto {
    pub machine_hash: String,
    pub peer_tag: String,
    pub nickname: String,
    pub avatar_url: String,
    pub telemetry_consent: String,
    pub preferred_fps: u32,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FriendHubRowDto {
    pub hub_id: String,
    pub owner_nickname: String,
    pub owner_tag: String,
    pub owner_avatar: String,
    pub last_joined_at: i64,
    pub is_favorite: bool,
}

/// Computes the lowercase SHA-256 hex digest of the raw machine identifier.
pub fn hash_machine_uid(raw_machine_uid: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_machine_uid.trim().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

/// Derives a fixed, low-collision 10-character exchangeable peer tag from the machine hash.
pub fn derive_fixed_peer_tag(machine_hash: &str) -> String {
    let prefix_len = 10.min(machine_hash.len());
    format!("#{}", &machine_hash[..prefix_len])
}

/// Initializes the local SQLite database file and ensures required tables exist.
pub fn init_db(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open_connection(app)?;
    ensure_schema(&conn)
}

fn require_non_empty<'a>(value: &'a str, field_name: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }
    Ok(trimmed)
}

fn normalize_peer_tag(raw_tag: &str) -> Result<String, String> {
    let trimmed = require_non_empty(raw_tag, "defaultTag")?;
    if trimmed.starts_with('#') {
        return Ok(trimmed.to_string());
    }
    Ok(format!("#{trimmed}"))
}

fn validate_fps(preferred_fps: Option<u32>) -> Result<Option<u32>, String> {
    let Some(fps) = preferred_fps else {
        return Ok(None);
    };
    if fps != DEFAULT_FPS && fps != FALLBACK_FPS {
        return Err(format!(
            "preferredFps must be {FALLBACK_FPS} or {DEFAULT_FPS}"
        ));
    }
    Ok(Some(fps))
}

fn validate_consent(consent: &str) -> Result<&str, String> {
    let trimmed = require_non_empty(consent, "consent")?;
    if !VALID_CONSENT_VALUES.contains(&trimmed) {
        return Err("consent must be 'unset', 'granted', or 'denied'".to_string());
    }
    Ok(trimmed)
}

fn current_unix_ms() -> Result<i64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    i64::try_from(duration.as_millis()).map_err(|e| e.to_string())
}

fn resolve_last_joined_at(raw_timestamp: i64) -> Result<i64, String> {
    if raw_timestamp > 0 {
        return Ok(raw_timestamp);
    }
    current_unix_ms()
}

fn resolve_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    }
    Ok(data_dir.join(DB_FILE_NAME))
}

fn open_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn open_ready_connection(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = open_connection(app)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_profile (
            machine_hash TEXT PRIMARY KEY,
            peer_tag TEXT NOT NULL UNIQUE,
            nickname TEXT NOT NULL,
            avatar_url TEXT NOT NULL,
            telemetry_consent TEXT NOT NULL DEFAULT 'unset',
            preferred_fps INTEGER NOT NULL DEFAULT 60,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS friend_hubs (
            hub_id TEXT PRIMARY KEY,
            owner_nickname TEXT NOT NULL,
            owner_tag TEXT NOT NULL,
            owner_avatar TEXT NOT NULL DEFAULT '',
            last_joined_at INTEGER NOT NULL,
            is_favorite INTEGER NOT NULL DEFAULT 0
        );",
    )
    .map_err(|e| e.to_string())
}

fn map_profile_row(row: &Row<'_>) -> rusqlite::Result<ProfileRowDto> {
    Ok(ProfileRowDto {
        machine_hash: row.get(0)?,
        peer_tag: row.get(1)?,
        nickname: row.get(2)?,
        avatar_url: row.get(3)?,
        telemetry_consent: row.get(4)?,
        preferred_fps: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn map_friend_hub_row(row: &Row<'_>) -> rusqlite::Result<FriendHubRowDto> {
    let is_favorite_int: i64 = row.get(5)?;
    Ok(FriendHubRowDto {
        hub_id: row.get(0)?,
        owner_nickname: row.get(1)?,
        owner_tag: row.get(2)?,
        owner_avatar: row.get(3)?,
        last_joined_at: row.get(4)?,
        is_favorite: is_favorite_int != 0,
    })
}

fn find_profile_by_hash(
    conn: &Connection,
    machine_hash: &str,
) -> Result<Option<ProfileRowDto>, String> {
    conn.query_row(
        "SELECT machine_hash, peer_tag, nickname, avatar_url, telemetry_consent, preferred_fps, updated_at
         FROM user_profile
         WHERE machine_hash = ?1",
        params![machine_hash],
        map_profile_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn get_or_init_profile_inner(
    conn: &Connection,
    raw_machine_uid: &str,
    default_nickname: &str,
    default_tag: &str,
    default_avatar: &str,
) -> Result<ProfileRowDto, String> {
    let machine_uid = require_non_empty(raw_machine_uid, "rawMachineUid")?;
    let nickname = require_non_empty(default_nickname, "defaultNickname")?;
    let machine_hash = hash_machine_uid(machine_uid);
    let peer_tag = if default_tag.trim().is_empty() {
        derive_fixed_peer_tag(&machine_hash)
    } else {
        normalize_peer_tag(default_tag)?
    };

    if let Some(existing) = find_profile_by_hash(conn, &machine_hash)? {
        return Ok(existing);
    }

    let now = current_unix_ms()?;
    conn.execute(
        "INSERT INTO user_profile (
            machine_hash, peer_tag, nickname, avatar_url, telemetry_consent, preferred_fps, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'unset', ?5, ?6)
        ON CONFLICT(machine_hash) DO NOTHING",
        params![
            machine_hash,
            peer_tag,
            nickname,
            default_avatar.trim(),
            DEFAULT_FPS,
            now
        ],
    )
    .map_err(|e| e.to_string())?;

    find_profile_by_hash(conn, &machine_hash)?
        .ok_or_else(|| "Failed to initialize profile row".to_string())
}

fn update_profile_inner(
    conn: &Connection,
    raw_machine_uid: &str,
    nickname: &str,
    avatar_url: &str,
    preferred_fps: Option<u32>,
) -> Result<ProfileRowDto, String> {
    let machine_uid = require_non_empty(raw_machine_uid, "rawMachineUid")?;
    let clean_nickname = require_non_empty(nickname, "nickname")?;
    let validated_fps = validate_fps(preferred_fps)?;
    let machine_hash = hash_machine_uid(machine_uid);
    let now = current_unix_ms()?;

    let rows_affected = conn
        .execute(
            "UPDATE user_profile
             SET nickname = ?1,
                 avatar_url = ?2,
                 preferred_fps = COALESCE(?3, preferred_fps),
                 updated_at = ?4
             WHERE machine_hash = ?5",
            params![
                clean_nickname,
                avatar_url.trim(),
                validated_fps,
                now,
                machine_hash
            ],
        )
        .map_err(|e| e.to_string())?;

    if rows_affected == 0 {
        return Err("Profile not initialized for this machine".to_string());
    }

    find_profile_by_hash(conn, &machine_hash)?
        .ok_or_else(|| "Updated profile could not be loaded".to_string())
}

fn set_telemetry_consent_inner(
    conn: &Connection,
    raw_machine_uid: &str,
    consent: &str,
) -> Result<ProfileRowDto, String> {
    let machine_uid = require_non_empty(raw_machine_uid, "rawMachineUid")?;
    let clean_consent = validate_consent(consent)?;
    let machine_hash = hash_machine_uid(machine_uid);
    let now = current_unix_ms()?;

    let rows_affected = conn
        .execute(
            "UPDATE user_profile
             SET telemetry_consent = ?1,
                 updated_at = ?2
             WHERE machine_hash = ?3",
            params![clean_consent, now, machine_hash],
        )
        .map_err(|e| e.to_string())?;

    if rows_affected == 0 {
        return Err("Profile not initialized for this machine".to_string());
    }

    find_profile_by_hash(conn, &machine_hash)?
        .ok_or_else(|| "Updated profile could not be loaded".to_string())
}

fn list_friend_hubs_inner(conn: &Connection) -> Result<Vec<FriendHubRowDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT hub_id, owner_nickname, owner_tag, owner_avatar, last_joined_at, is_favorite
             FROM friend_hubs
             ORDER BY is_favorite DESC, last_joined_at DESC, hub_id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], map_friend_hub_row)
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn upsert_friend_hub_inner(
    conn: &Connection,
    hub: &FriendHubRowDto,
) -> Result<Vec<FriendHubRowDto>, String> {
    let hub_id = require_non_empty(&hub.hub_id, "hub.hubId")?;
    let owner_nickname = require_non_empty(&hub.owner_nickname, "hub.ownerNickname")?;
    let owner_tag = require_non_empty(&hub.owner_tag, "hub.ownerTag")?;
    let last_joined_at = resolve_last_joined_at(hub.last_joined_at)?;
    let is_favorite_int = i64::from(hub.is_favorite);

    conn.execute(
        "INSERT INTO friend_hubs (
            hub_id, owner_nickname, owner_tag, owner_avatar, last_joined_at, is_favorite
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(hub_id) DO UPDATE SET
            owner_nickname = excluded.owner_nickname,
            owner_tag = excluded.owner_tag,
            owner_avatar = excluded.owner_avatar,
            last_joined_at = excluded.last_joined_at,
            is_favorite = excluded.is_favorite",
        params![
            hub_id,
            owner_nickname,
            owner_tag,
            hub.owner_avatar.trim(),
            last_joined_at,
            is_favorite_int
        ],
    )
    .map_err(|e| e.to_string())?;

    list_friend_hubs_inner(conn)
}

fn remove_friend_hub_inner(
    conn: &Connection,
    hub_id: &str,
) -> Result<Vec<FriendHubRowDto>, String> {
    let clean_hub_id = require_non_empty(hub_id, "hubId")?;
    conn.execute(
        "DELETE FROM friend_hubs WHERE hub_id = ?1",
        params![clean_hub_id],
    )
    .map_err(|e| e.to_string())?;

    list_friend_hubs_inner(conn)
}

#[tauri::command]
pub fn db_get_or_init_profile(
    app: tauri::AppHandle,
    raw_machine_uid: String,
    default_nickname: String,
    default_tag: String,
    default_avatar: String,
) -> Result<ProfileRowDto, String> {
    let conn = open_ready_connection(&app)?;
    get_or_init_profile_inner(
        &conn,
        &raw_machine_uid,
        &default_nickname,
        &default_tag,
        &default_avatar,
    )
}

#[tauri::command]
pub fn db_update_profile(
    app: tauri::AppHandle,
    raw_machine_uid: String,
    nickname: String,
    avatar_url: String,
    preferred_fps: Option<u32>,
) -> Result<ProfileRowDto, String> {
    let conn = open_ready_connection(&app)?;
    update_profile_inner(
        &conn,
        &raw_machine_uid,
        &nickname,
        &avatar_url,
        preferred_fps,
    )
}

#[tauri::command]
pub fn db_set_telemetry_consent(
    app: tauri::AppHandle,
    raw_machine_uid: String,
    consent: String,
) -> Result<ProfileRowDto, String> {
    let conn = open_ready_connection(&app)?;
    set_telemetry_consent_inner(&conn, &raw_machine_uid, &consent)
}

#[tauri::command]
pub fn db_list_friend_hubs(app: tauri::AppHandle) -> Result<Vec<FriendHubRowDto>, String> {
    let conn = open_ready_connection(&app)?;
    list_friend_hubs_inner(&conn)
}

#[tauri::command]
pub fn db_upsert_friend_hub(
    app: tauri::AppHandle,
    hub: FriendHubRowDto,
) -> Result<Vec<FriendHubRowDto>, String> {
    let conn = open_ready_connection(&app)?;
    upsert_friend_hub_inner(&conn, &hub)
}

#[tauri::command]
pub fn db_remove_friend_hub(
    app: tauri::AppHandle,
    hub_id: String,
) -> Result<Vec<FriendHubRowDto>, String> {
    let conn = open_ready_connection(&app)?;
    remove_friend_hub_inner(&conn, &hub_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_memory_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        ensure_schema(&conn).expect("create schema");
        conn
    }

    #[test]
    fn machine_uid_hash_is_deterministic_sha256_hex() {
        let digest = hash_machine_uid("machine-abc-123");
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, hash_machine_uid("  machine-abc-123  "));
        assert_ne!(digest, hash_machine_uid("machine-xyz-999"));
    }

    #[test]
    fn profile_preserves_locked_peer_tag_across_reinit_and_updates() {
        let conn = setup_memory_conn();
        let initial = get_or_init_profile_inner(
            &conn,
            "uid-001",
            "Mochi",
            "abcd1",
            "avatar_01_sunny.png",
        )
        .expect("init profile");
        assert_eq!(initial.peer_tag, "#abcd1");
        assert_eq!(initial.telemetry_consent, "unset");
        assert_eq!(initial.preferred_fps, 60);

        let second = get_or_init_profile_inner(
            &conn,
            "uid-001",
            "Other",
            "#zzzz9",
            "avatar_02_library.png",
        )
        .expect("re-get existing profile");
        assert_eq!(second.peer_tag, "#abcd1");
        assert_eq!(second.nickname, "Mochi");

        let updated = update_profile_inner(
            &conn,
            "uid-001",
            "Nova",
            "avatar_03_red.png",
            Some(30),
        )
        .expect("update profile");
        assert_eq!(updated.peer_tag, "#abcd1");
        assert_eq!(updated.nickname, "Nova");
        assert_eq!(updated.preferred_fps, 30);

        let consented = set_telemetry_consent_inner(&conn, "uid-001", "granted")
            .expect("set telemetry consent");
        assert_eq!(consented.telemetry_consent, "granted");
    }

    #[test]
    fn friend_hubs_upsert_list_and_remove() {
        let conn = setup_memory_conn();
        let hub = FriendHubRowDto {
            hub_id: "elfy/hub/Mochi_abcd1".to_string(),
            owner_nickname: "Mochi".to_string(),
            owner_tag: "#abcd1".to_string(),
            owner_avatar: "avatar_01_sunny.png".to_string(),
            last_joined_at: 1_700_000_000_000,
            is_favorite: true,
        };
        let list = upsert_friend_hub_inner(&conn, &hub).expect("upsert hub");
        assert_eq!(list.len(), 1);
        assert!(list[0].is_favorite);

        let after_remove = remove_friend_hub_inner(&conn, "elfy/hub/Mochi_abcd1")
            .expect("remove hub");
        assert!(after_remove.is_empty());
    }
}
