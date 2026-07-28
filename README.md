# Rollmap

Rollmap is a local-first Brazilian jiu-jitsu knowledge map for macOS and
Android. Positions are nodes and techniques are directed connections between
them. Each item can store notes, links, images, and videos.

## Features

- Multiple isolated knowledge databases, with the original data retained as the
	permanent default database
- Persistent SQLite graph data, a shared media content pool, and per-database
	media mappings
- Signed device pairing and bidirectional graph, catalog, and media sync over a
	local network
- Foreground DNS-SD discovery and automatic synchronization with trusted devices
- Content-addressed image and video storage with resumable, verified downloads
- Search, category and role filters, and automatic ELK graph layout
- Per-database Undo and Redo on macOS and Android, including Command/Ctrl+Z,
  Command/Ctrl+Shift+Z, and Ctrl+Y keyboard shortcuts
- A virtual Unknown destination for transitions whose next position is not yet
	known; edit the transition later to point it at a real position
- Full-video or preview-selected clip imports
- macOS video drag and drop for the selected position or transition, reusing
	the quality and clip-range import controls for MP4, MOV, and M4V files
- Compact 540p video storage by default, with 720p, 1080p, and original-quality
	options
- Bilibili share-link recognition with automatic titles, multi-part selection,
  and exact playback timestamps

Video processing uses macOS `/usr/bin/avconvert`, so desktop video import accepts
MP4, MOV, and M4V files. Images accept PNG, JPEG, GIF, and WebP files.

Bilibili links remain ordinary link attachments. Pasting a Bilibili page, player,
or `b23.tv` share link loads public video metadata when available and saves a
clean `p` and `t` URL. If metadata is unavailable, the original link can still
be saved. Recognized videos can be previewed in the official embedded player;
Rollmap's timeline, five-second adjustments, and time field select the saved
start point and reload the preview only after a selection is committed.

## Storage and Sync Foundation

Native builds keep stable library and device identities in
`rollmap-catalog.db`. Every knowledge database uses the same native migration
list, creates a consistent SQLite backup before an upgrade, and currently
targets graph schema v10. Catalog schema v5 stores trusted peer identities,
per-library authorizations, one-time pairing sessions, remembered LAN endpoints,
and hybrid-logical-clock revisions and tombstones for each library.

All native graph writes pass through the Rust `SyncStore` transaction layer.
It atomically updates graph records, a hybrid logical clock, an append-only
journal, current record versions, tombstones, peer cursors, and conflict audit
records. Position content and layout use separate sync streams. The engine can
page and merge bidirectional record changes with deterministic conflict
resolution and operation-ID deduplication; the browser fallback remains
localStorage-only. Incremental reads report stale cursors instead of silently
skipping compacted history. The native API can export and transactionally apply
current-winner snapshots, including tombstones and winning operation IDs, then
resume from the snapshot's journal cursor. Journal compaction waits for every
trusted peer authorized for that library to acknowledge the retained range;
current winners, tombstones, and conflict audit records are not pruned.

Undo and Redo keep up to 100 in-memory graph revisions per database for the
current app session. Restoring a revision is an atomic graph mutation, and its
result synchronizes like any other edit. Entity generations let an explicit
restore supersede an older tombstone without allowing stale updates to revive
deleted data.

Native builds expose manual LAN pairing and synchronization from the toolbar.
One device starts a server and creates a pasteable pairing payload; the other
device selects the offered databases and joins. After pairing, protocol v3
synchronizes the catalog by stable library UUID. New libraries create replicas
with device-local database and media paths; renames and deletion tombstones
converge without synchronizing local paths. Each library sync is isolated, so a
broken replica is reported while the remaining libraries continue. Incremental
graph sync falls back to current-winner snapshots when a cursor is stale.

While the app is in the foreground, its LAN server advertises and browses
`_rollmap._tcp.local.`. Discovery records contain only the protocol major,
device UUID, app version, and pairing availability. A discovered endpoint is
used automatically only when its UUID is already trusted, and `/v1/hello` plus
the signed session still verify the remote identity. Successful endpoints are
remembered. Android holds a Wi-Fi multicast lock only while its activity is in
the foreground.

Image and video attachment records synchronize their SHA-256 hash, MIME type,
extension, and byte size, never a device-local file path. Files live in a shared
content-addressed pool and download on demand from an authorized trusted peer.
The Sync dialog can also download every missing object for the active library,
with byte/file progress, per-object failure isolation, and immediate pause.
Interrupted or paused transfers resume with HTTP Range from a `.part` file;
size and SHA-256 are verified before an atomic rename, and corrupt partials are
discarded before another peer is tried. Notes and links continue to sync inline.
The Sync dialog can scan shared storage across every active library and remove
unreferenced blobs, stale records, and abandoned partial downloads.

The current transport is intentionally test-stage: devices have Ed25519
identities, pairing tokens are signed, short-lived, and one-use, and each sync
session uses signed challenge-response authentication, but traffic is plain
HTTP. The private signing key is also stored in plaintext catalog metadata.
Before release, replace that backend with macOS Keychain and Android Keystore,
and add TLS. Android pairing payloads can be scanned with the built-in QR
scanner. Never synchronize a live SQLite database by copying its database, WAL,
or SHM files.

## Development

Requirements: macOS, Node.js, npm, and the Rust toolchain.

```sh
npm install
npm run tauri dev
```

Validation and packaging:

```sh
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
npm run tauri build
```

The packaged app and DMG are generated under `src-tauri/target/release/bundle/`.

## Android Development

Android builds require Android Studio's JBR, Android SDK 36, Build Tools 35 and
36, NDK 29, and the Rust Android targets. The following paths assume Android
Studio and its SDK use their default macOS locations.

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.13846066"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
sdkmanager \
	"platform-tools" \
	"platforms;android-36" \
	"build-tools;35.0.0" \
	"build-tools;36.0.0" \
	"ndk;29.0.13846066"

rustup target add \
	aarch64-linux-android \
	armv7-linux-androideabi \
	i686-linux-android \
	x86_64-linux-android
```

Generate the Android Studio project once, then build the arm64 debug APK:

```sh
npm run tauri android init -- --ci --skip-targets-install
npm run tauri android build -- --debug --apk --target aarch64
```

The debug APK is generated at
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
Despite the `universal` directory name, the command above packages only the
arm64 ABI. Release signing is not configured by this command.

To run the APK on a local Pixel 7 emulator:

```sh
sdkmanager \
	"emulator" \
	"system-images;android-36;google_apis;arm64-v8a"

printf 'no\n' | avdmanager create avd \
	--force \
	--name Rollmap_API_36 \
	--package "system-images;android-36;google_apis;arm64-v8a" \
	--device pixel_7

emulator -avd Rollmap_API_36
```

After the emulator finishes booting, install or update the debug APK:

```sh
adb install -r -t \
	src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```
