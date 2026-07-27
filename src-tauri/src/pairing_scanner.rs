use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
use serde::Deserialize;
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, AppHandle, Manager};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.rollmap.app";

#[cfg(target_os = "android")]
struct PairingScanner<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct ScanResult {
    value: Option<String>,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("pairing-scanner");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "PairingScannerPlugin")?;
        app.manage(PairingScanner(handle));
        Ok(())
    });
    builder.build()
}

#[cfg(target_os = "android")]
pub async fn scan<R: Runtime>(app: &AppHandle<R>) -> Result<Option<String>, String> {
    app.state::<PairingScanner<R>>()
        .0
        .run_mobile_plugin_async::<ScanResult>("scan", ())
        .await
        .map(|result| result.value)
        .map_err(|error| error.to_string())
}
