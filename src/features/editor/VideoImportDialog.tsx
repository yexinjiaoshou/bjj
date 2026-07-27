import { Scissors, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type {
  VideoImportDraft,
  VideoImportOptions,
  VideoQuality,
} from "../../services/media";

interface VideoImportDialogProps {
  draft: VideoImportDraft;
  isBusy: boolean;
  canCancelWhileBusy: boolean;
  onConfirm: (options: VideoImportOptions) => void;
  onCancel: () => void;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function VideoImportDialog({
  draft,
  isBusy,
  canCancelWhileBusy,
  onConfirm,
  onCancel,
}: VideoImportDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<"full" | "clip">("full");
  const [quality, setQuality] = useState<VideoQuality>("compact");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [clipStart, setClipStart] = useState(0);
  const [clipEnd, setClipEnd] = useState(0);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  function handleMetadata() {
    const nextDuration = videoRef.current?.duration ?? 0;
    if (!Number.isFinite(nextDuration) || nextDuration <= 0) {
      setPreviewState("error");
      return;
    }
    setDuration(nextDuration);
    setClipEnd(nextDuration);
    setPreviewState("ready");
  }

  function setStart(seconds: number) {
    setClipStart(Math.max(0, Math.min(seconds, clipEnd - 0.1)));
  }

  function setEnd(seconds: number) {
    setClipEnd(Math.min(duration, Math.max(seconds, clipStart + 0.1)));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm({
      quality,
      startSeconds: mode === "clip" ? clipStart : null,
      endSeconds: mode === "clip" ? clipEnd : null,
    });
  }

  return (
    <div className="dialog-backdrop" onMouseDown={isBusy ? undefined : onCancel}>
      <section
        className="entity-dialog video-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Video source</span>
            <h2 id="video-import-title">Import {draft.title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            disabled={isBusy}
          >
            <X size={18} />
          </button>
        </header>

        <form className="video-import-form" onSubmit={handleSubmit}>
          <div className="video-import-preview">
            <video
              ref={videoRef}
              src={draft.previewUrl}
              controls
              preload="metadata"
              onLoadedMetadata={handleMetadata}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onError={() => {
                setPreviewState("error");
                setMode("full");
              }}
            />
            {previewState === "error" && (
              <p>Preview unavailable. The full video can still be imported.</p>
            )}
          </div>

          <div className="video-import-settings">
            <fieldset className="field field--wide">
              <legend>Import range</legend>
              <div className="segmented-control video-range-mode">
                <label>
                  <input
                    type="radio"
                    name="video-range"
                    checked={mode === "full"}
                    onChange={() => setMode("full")}
                  />
                  <span>Full video</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="video-range"
                    checked={mode === "clip"}
                    onChange={() => setMode("clip")}
                    disabled={previewState !== "ready"}
                  />
                  <span>Clip</span>
                </label>
              </div>
            </fieldset>

            {mode === "clip" && (
              <section className="video-clip-editor">
                <div className="video-clip-editor__summary">
                  <Scissors size={14} />
                  <strong>{formatTime(clipStart)}</strong>
                  <span>to</span>
                  <strong>{formatTime(clipEnd)}</strong>
                  <small>{formatTime(clipEnd - clipStart)}</small>
                </div>
                <label>
                  <span>Start</span>
                  <input
                    aria-label="Clip start"
                    type="range"
                    min={0}
                    max={Math.max(0, clipEnd - 0.1)}
                    step={0.1}
                    value={clipStart}
                    onChange={(event) => setStart(Number(event.target.value))}
                  />
                  <button type="button" onClick={() => setStart(currentTime)}>
                    Use current
                  </button>
                </label>
                <label>
                  <span>End</span>
                  <input
                    aria-label="Clip end"
                    type="range"
                    min={Math.min(duration, clipStart + 0.1)}
                    max={duration}
                    step={0.1}
                    value={clipEnd}
                    onChange={(event) => setEnd(Number(event.target.value))}
                  />
                  <button type="button" onClick={() => setEnd(currentTime)}>
                    Use current
                  </button>
                </label>
              </section>
            )}

            <label className="field field--wide">
              <span>Storage quality</span>
              <select
                aria-label="Video storage quality"
                value={quality}
                onChange={(event) => setQuality(event.target.value as VideoQuality)}
              >
                <option value="compact">Compact · 540p</option>
                <option value="balanced">Balanced · up to 720p</option>
                <option value="high">High · up to 1080p</option>
                <option value="original">Original resolution</option>
              </select>
            </label>

            <footer className="form-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={onCancel}
                disabled={isBusy && !canCancelWhileBusy}
              >
                {isBusy && canCancelWhileBusy ? "Cancel processing" : "Cancel"}
              </button>
              <button type="submit" className="primary-button" disabled={isBusy}>
                {isBusy ? "Processing video..." : "Import video"}
              </button>
            </footer>
          </div>
        </form>
      </section>
    </div>
  );
}