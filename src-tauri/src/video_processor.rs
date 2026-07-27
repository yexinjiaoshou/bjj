use tauri::{plugin::TauriPlugin, Runtime};

#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use std::path::Path;
#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, AppHandle, Manager};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.rollmap.app";

#[cfg(target_os = "android")]
struct VideoProcessor<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessVideoRequest<'a> {
    operation_id: &'a str,
    input_path: &'a str,
    output_path: &'a str,
    quality: &'a str,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelVideoRequest<'a> {
    operation_id: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct CancelVideoResponse {
    cancelled: bool,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = tauri::plugin::Builder::new("video-processor");
    #[cfg(target_os = "android")]
    let builder = builder.setup(|app, api| {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VideoProcessorPlugin")?;
        app.manage(VideoProcessor(handle));
        Ok(())
    });
    builder.build()
}

#[cfg(target_os = "android")]
pub async fn process_video<R: Runtime>(
    app: &AppHandle<R>,
    operation_id: &str,
    input_path: &Path,
    output_path: &Path,
    quality: &str,
    start_seconds: Option<f64>,
    duration_seconds: Option<f64>,
) -> Result<(), String> {
    let input_path = input_path
        .to_str()
        .ok_or("The staged video path is not valid UTF-8")?;
    let output_path = output_path
        .to_str()
        .ok_or("The processed video path is not valid UTF-8")?;
    app.state::<VideoProcessor<R>>()
        .0
        .run_mobile_plugin_async(
            "processVideo",
            ProcessVideoRequest {
                operation_id,
                input_path,
                output_path,
                quality,
                start_seconds,
                duration_seconds,
            },
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
pub async fn cancel_video<R: Runtime>(
    app: &AppHandle<R>,
    operation_id: &str,
) -> Result<bool, String> {
    app.state::<VideoProcessor<R>>()
        .0
        .run_mobile_plugin_async("cancelVideo", CancelVideoRequest { operation_id })
        .await
        .map(|response: CancelVideoResponse| response.cancelled)
        .map_err(|error| error.to_string())
}
