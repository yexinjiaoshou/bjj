import {
  Clock3,
  Download,
  ExternalLink,
  FastForward,
  FileImage,
  Film,
  Link as LinkIcon,
  LoaderCircle,
  Maximize2,
  Plus,
  Play,
  RefreshCw,
  Rewind,
  StickyNote,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "../../domain/types";
import {
  buildBilibiliUrl,
  buildBilibiliPlayerUrl,
  describeBilibiliLink,
  extractHttpUrl,
  formatTimestamp,
  inspectBilibiliLink,
  isBilibiliUrl,
  parseBilibiliLink,
  parseTimestamp,
  type BilibiliVideoInfo,
} from "../../services/bilibili";
import {
  normalizeHttpUrl,
  resolveMediaUrl,
} from "../../services/media";
import {
  parseClipboardLink,
  readClipboardText,
} from "../../services/clipboard";

declare global {
  interface Window {
    __ROLLMAP_CLOSE_ACTIVE_OVERLAY__?: () => boolean;
  }
}

type EditableAttachmentKind = Extract<Attachment["kind"], "note" | "link">;
type MediaAttachmentKind = Extract<Attachment["kind"], "image" | "video">;

interface VideoPlayback {
  currentTime: number;
  playing: boolean;
}

function readVideoPlayback(video: HTMLVideoElement): VideoPlayback {
  return {
    currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
    playing: !video.paused,
  };
}

function seekVideo(video: HTMLVideoElement, currentTime: number) {
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return;
  }
  try {
    video.currentTime = currentTime;
  } catch {}
}

function resumeVideo(video: HTMLVideoElement) {
  void video.play().catch(() => {});
}

interface BilibiliPreviewTarget {
  page: number;
  startSeconds: number;
  revision: number;
}

interface AttachmentPanelProps {
  ownerType: Attachment["ownerType"];
  ownerId: string;
  attachments: Attachment[];
  isBusy: boolean;
  isActive?: boolean;
  onSave: (attachment: Attachment) => void;
  onAddMedia: (kind: MediaAttachmentKind) => void;
  onDelete: (attachment: Attachment) => void;
  onDownload: (attachment: Attachment) => void;
  onOpen: (attachment: Attachment) => void;
}

interface AttachmentDialogProps {
  ownerType: Attachment["ownerType"];
  ownerId: string;
  kind: EditableAttachmentKind;
  isBusy: boolean;
  onSave: (attachment: Attachment) => void;
  onOpen: (attachment: Attachment) => void;
  onClose: () => void;
}

function suggestedBilibiliTitle(info: BilibiliVideoInfo, page: number) {
  const selectedPage = info.pages.find((item) => item.page === page);
  return info.pages.length > 1 && selectedPage?.part
    ? `${info.title} · ${selectedPage.part}`
    : info.title;
}

function AttachmentDialog({
  ownerType,
  ownerId,
  kind,
  isBusy,
  onSave,
  onOpen,
  onClose,
}: AttachmentDialogProps) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [bilibiliInfo, setBilibiliInfo] = useState<BilibiliVideoInfo | null>(null);
  const [bilibiliError, setBilibiliError] = useState<string | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [selectedPage, setSelectedPage] = useState(1);
  const [startTime, setStartTime] = useState("0:00");
  const [previewTarget, setPreviewTarget] = useState<BilibiliPreviewTarget | null>(
    null,
  );
  const titleWasEdited = useRef(false);
  const valueWasEdited = useRef(false);
  const inspectionVersion = useRef(0);

  useEffect(
    () => () => {
      inspectionVersion.current += 1;
    },
    [],
  );

  async function recognizeBilibili(nextValue: string) {
    if (!isBilibiliUrl(nextValue)) {
      return;
    }
    const version = ++inspectionVersion.current;
    setIsInspecting(true);
    setBilibiliError(null);
    setValidationError(null);
    try {
      const info = await inspectBilibiliLink(nextValue);
      if (version !== inspectionVersion.current) {
        return;
      }
      setBilibiliInfo(info);
      setSelectedPage(info.selectedPage);
      const selectedPart = info.pages.find((item) => item.page === info.selectedPage);
      const maximum = Math.max(0, (selectedPart?.durationSeconds ?? 1) - 1);
      const initialSeconds = Math.min(info.startSeconds, maximum);
      setStartTime(formatTimestamp(initialSeconds));
      setPreviewTarget({
        page: info.selectedPage,
        startSeconds: initialSeconds,
        revision: 0,
      });
      if (!titleWasEdited.current) {
        setTitle(suggestedBilibiliTitle(info, info.selectedPage));
      }
    } catch (error) {
      if (version === inspectionVersion.current) {
        setBilibiliInfo(null);
        setBilibiliError(
          error instanceof Error ? error.message : "Could not load video details",
        );
      }
    } finally {
      if (version === inspectionVersion.current) {
        setIsInspecting(false);
      }
    }
  }

  function fillLinkFromText(sourceText: string) {
    const clipboardLink = parseClipboardLink(sourceText);
    if (!clipboardLink) {
      return false;
    }
    setValue(clipboardLink.url);
    setBilibiliInfo(null);
    setBilibiliError(null);
    if (clipboardLink.title && !titleWasEdited.current) {
      setTitle(clipboardLink.title);
    }
    if (isBilibiliUrl(clipboardLink.url)) {
      void recognizeBilibili(clipboardLink.url);
    }
    return true;
  }

  useEffect(() => {
    if (kind !== "link") {
      return;
    }
    let cancelled = false;
    void readClipboardText()
      .then((clipboardText) => {
        if (
          cancelled ||
          valueWasEdited.current ||
          typeof clipboardText !== "string"
        ) {
          return;
        }
        fillLinkFromText(clipboardText);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind]);

  function currentBilibiliUrl() {
    if (!bilibiliInfo) {
      return null;
    }
    const startSeconds = parseTimestamp(startTime);
    const page = bilibiliInfo.pages.find((item) => item.page === selectedPage);
    if (page && page.durationSeconds > 0 && startSeconds >= page.durationSeconds) {
      throw new Error(`Start time must be before ${formatTimestamp(page.durationSeconds)}`);
    }
    return buildBilibiliUrl({
      bvid: bilibiliInfo.bvid,
      page: selectedPage,
      startSeconds,
    });
  }

  function commitBilibiliPreview(page: number, seconds: number) {
    if (!bilibiliInfo) {
      return;
    }
    const selectedPart = bilibiliInfo.pages.find((item) => item.page === page);
    const maximum = Math.max(0, (selectedPart?.durationSeconds ?? 1) - 1);
    const nextSeconds = Math.max(0, Math.min(Math.floor(seconds), maximum));
    setStartTime(formatTimestamp(nextSeconds));
    setValidationError(null);
    setPreviewTarget((current) => ({
      page,
      startSeconds: nextSeconds,
      revision: (current?.revision ?? 0) + 1,
    }));
  }

  function commitTimeInput() {
    try {
      commitBilibiliPreview(selectedPage, parseTimestamp(startTime));
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleLinkPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pastedValue = event.clipboardData.getData("text");
    if (!parseClipboardLink(pastedValue)) {
      return;
    }
    event.preventDefault();
    valueWasEdited.current = true;
    fillLinkFromText(pastedValue);
  }

  function testBilibiliLink() {
    try {
      const nextValue = currentBilibiliUrl();
      if (!nextValue) {
        return;
      }
      setValidationError(null);
      onOpen({
        id: "bilibili-preview",
        ownerType,
        ownerId,
        kind: "link",
        title: title.trim() || bilibiliInfo?.title || "Bilibili",
        value: nextValue,
      });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setValidationError(kind === "link" ? "Enter a URL." : "Enter a note.");
      return;
    }

    try {
      const normalizedValue =
        kind === "link"
          ? currentBilibiliUrl() ??
            (() => {
              const normalized = normalizeHttpUrl(extractHttpUrl(trimmedValue));
              const parsed = parseBilibiliLink(normalized);
              return parsed ? buildBilibiliUrl(parsed) : normalized;
            })()
          : trimmedValue;
      const fallbackTitle = kind === "link" ? new URL(normalizedValue).hostname : "Note";
      onSave({
        id: crypto.randomUUID(),
        ownerType,
        ownerId,
        kind,
        title: title.trim() || fallbackTitle,
        value: normalizedValue,
      });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={isBusy ? undefined : onClose}>
      <section
        className={`entity-dialog attachment-dialog${kind === "link" ? " attachment-dialog--link" : ""}${bilibiliInfo ? " attachment-dialog--bilibili" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Source</span>
            <h2 id="attachment-dialog-title">
              {kind === "link" ? "Add link" : "Add note"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Close"
            aria-label="Close"
            onClick={onClose}
            disabled={isBusy}
          >
            <X size={18} />
          </button>
        </header>
        <form className="entity-form" onSubmit={handleSubmit}>
          <label className="field field--wide">
            <span>Title</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => {
                titleWasEdited.current = true;
                setTitle(event.target.value);
              }}
              placeholder={kind === "link" ? "Source or instructor" : "Short label"}
            />
          </label>
          <div className="field field--wide">
            <label htmlFor="attachment-value">{kind === "link" ? "URL" : "Note"}</label>
            {kind === "link" ? (
              <div className="attachment-url-control">
                <input
                  id="attachment-value"
                  aria-label="URL"
                  required
                  type="url"
                  value={value}
                  onPaste={handleLinkPaste}
                  onBlur={() => {
                    if (isBilibiliUrl(value) && !bilibiliInfo && !isInspecting) {
                      void recognizeBilibili(value);
                    }
                  }}
                  onChange={(event) => {
                    inspectionVersion.current += 1;
                    valueWasEdited.current = true;
                    setIsInspecting(false);
                    setValue(event.target.value);
                    setBilibiliInfo(null);
                    setBilibiliError(null);
                  }}
                  placeholder="https://example.com/technique"
                />
                {isBilibiliUrl(value) && (
                  <button
                    type="button"
                    title="Refresh Bilibili details"
                    aria-label="Refresh Bilibili details"
                    onClick={() => void recognizeBilibili(value)}
                    disabled={isInspecting}
                  >
                    {isInspecting ? (
                      <LoaderCircle className="is-spinning" size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                  </button>
                )}
              </div>
            ) : (
              <textarea
                id="attachment-value"
                aria-label="Note"
                required
                rows={5}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Add a detail, cue, or training observation"
              />
            )}
          </div>
          {kind === "link" && bilibiliInfo && (
            <section className="bilibili-import" aria-label="Bilibili video details">
              <header>
                <Tv size={16} />
                <div>
                  <strong>{bilibiliInfo.title}</strong>
                  <span>
                    {bilibiliInfo.owner} · {bilibiliInfo.bvid}
                  </span>
                </div>
                <button type="button" onClick={testBilibiliLink}>
                  <ExternalLink size={13} /> Test open
                </button>
              </header>
              <div className="bilibili-import__workspace">
                <div className="bilibili-player-preview">
                  {previewTarget && (
                    <iframe
                      key={`${previewTarget.page}-${previewTarget.startSeconds}-${previewTarget.revision}`}
                      title={`Bilibili preview: ${bilibiliInfo.title}`}
                      src={buildBilibiliPlayerUrl({
                        bvid: bilibiliInfo.bvid,
                        page: previewTarget.page,
                        startSeconds: previewTarget.startSeconds,
                      })}
                      allow="autoplay; fullscreen; picture-in-picture"
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  )}
                </div>
                <div className="bilibili-import__controls">
                  <label className="field">
                    <span>Part</span>
                    <select
                      aria-label="Video part"
                      value={selectedPage}
                      onChange={(event) => {
                        const nextPage = Number(event.target.value);
                        let nextSeconds = 0;
                        try {
                          nextSeconds = parseTimestamp(startTime);
                        } catch {
                          nextSeconds = 0;
                        }
                        setSelectedPage(nextPage);
                        commitBilibiliPreview(nextPage, nextSeconds);
                        if (!titleWasEdited.current) {
                          setTitle(suggestedBilibiliTitle(bilibiliInfo, nextPage));
                        }
                      }}
                    >
                      {bilibiliInfo.pages.map((page) => (
                        <option key={page.cid} value={page.page}>
                          P{page.page} · {page.part}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Start time</span>
                    <div className="bilibili-time-control">
                      <Clock3 size={14} />
                      <input
                        aria-label="Start time"
                        value={startTime}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            commitTimeInput();
                          }
                        }}
                        onChange={(event) => {
                          setStartTime(event.target.value);
                          setValidationError(null);
                        }}
                        placeholder="1:23"
                        inputMode="numeric"
                      />
                    </div>
                  </label>
                  <div className="bilibili-timeline">
                    <input
                      type="range"
                      aria-label="Preview time"
                      min={0}
                      max={Math.max(
                        0,
                        (bilibiliInfo.pages.find((item) => item.page === selectedPage)
                          ?.durationSeconds ?? 1) - 1,
                      )}
                      step={1}
                      value={(() => {
                        try {
                          const seconds = parseTimestamp(startTime);
                          const maximum = Math.max(
                            0,
                            (bilibiliInfo.pages.find(
                              (item) => item.page === selectedPage,
                            )?.durationSeconds ?? 1) - 1,
                          );
                          return Math.min(seconds, maximum);
                        } catch {
                          return previewTarget?.startSeconds ?? 0;
                        }
                      })()}
                      onChange={(event) => {
                        setStartTime(formatTimestamp(Number(event.target.value)));
                        setValidationError(null);
                      }}
                      onPointerUp={(event) =>
                        commitBilibiliPreview(
                          selectedPage,
                          Number(event.currentTarget.value),
                        )
                      }
                      onKeyUp={(event) =>
                        commitBilibiliPreview(
                          selectedPage,
                          Number(event.currentTarget.value),
                        )
                      }
                    />
                    <div className="bilibili-timeline__actions">
                      <button
                        type="button"
                        title="Back 5 seconds"
                        aria-label="Back 5 seconds"
                        onClick={() =>
                          commitBilibiliPreview(
                            selectedPage,
                            (() => {
                              try {
                                return parseTimestamp(startTime);
                              } catch {
                                return previewTarget?.startSeconds ?? 0;
                              }
                            })() - 5,
                          )
                        }
                      >
                        <Rewind size={15} />
                      </button>
                      <button
                        type="button"
                        title="Preview selected time"
                        aria-label="Preview selected time"
                        onClick={commitTimeInput}
                      >
                        <Play size={15} />
                      </button>
                      <button
                        type="button"
                        title="Forward 5 seconds"
                        aria-label="Forward 5 seconds"
                        onClick={() =>
                          commitBilibiliPreview(
                            selectedPage,
                            (() => {
                              try {
                                return parseTimestamp(startTime);
                              } catch {
                                return previewTarget?.startSeconds ?? 0;
                              }
                            })() + 5,
                          )
                        }
                      >
                        <FastForward size={15} />
                      </button>
                      <output>{formatTimestamp(previewTarget?.startSeconds ?? 0)}</output>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}
          {kind === "link" && bilibiliError && (
            <p className="bilibili-import-error" role="status">
              {bilibiliError}
            </p>
          )}
          {validationError && <p className="form-error">{validationError}</p>}
          <footer className="form-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={onClose}
              disabled={isBusy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={isBusy}
            >
              {isBusy ? "Saving..." : "Add source"}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body,
  );
}

function MediaViewer({
  kind,
  title,
  previewUrl,
  initialPlayback,
  isActive,
  onClose,
}: {
  kind: MediaAttachmentKind;
  title: string;
  previewUrl: string;
  initialPlayback?: VideoPlayback;
  isActive: boolean;
  onClose: (playback?: VideoPlayback) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeViewer = () => {
    const video = videoRef.current;
    const playback = video ? readVideoPlayback(video) : undefined;
    video?.pause();
    onClose(playback);
  };

  useEffect(() => {
    const previousCloseHandler = window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__;
    const closeActiveOverlay = () => {
      closeViewer();
      return true;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeViewer();
      }
    };

    window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__ = closeActiveOverlay;
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      videoRef.current?.pause();
      window.removeEventListener("keydown", handleKeyDown);
      if (window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__ === closeActiveOverlay) {
        if (previousCloseHandler) {
          window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__ = previousCloseHandler;
        } else {
          delete window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__;
        }
      }
    };
  }, [onClose]);

  useEffect(() => {
    if (!isActive) {
      closeViewer();
    }
  }, [isActive]);

  return createPortal(
    <section
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Fullscreen preview: ${title}`}
    >
      <header className="media-viewer__toolbar">
        <strong>{title}</strong>
        <button
          type="button"
          title="Close fullscreen preview"
          aria-label="Close fullscreen preview"
          onClick={closeViewer}
          autoFocus
        >
          <X size={21} />
        </button>
      </header>
      <div
        className="media-viewer__stage"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeViewer();
          }
        }}
      >
        {kind === "image" ? (
          <img src={previewUrl} alt={title} draggable={false} />
        ) : (
          <video
            ref={videoRef}
            src={previewUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              if (!initialPlayback) {
                return;
              }
              seekVideo(event.currentTarget, initialPlayback.currentTime);
              if (initialPlayback.playing) {
                resumeVideo(event.currentTarget);
              }
            }}
          />
        )}
      </div>
    </section>,
    document.body,
  );
}

function AttachmentItem({
  attachment,
  isBusy,
  onDelete,
  onDownload,
  onOpen,
  isActive,
}: Pick<
  AttachmentPanelProps,
  "isBusy" | "onDelete" | "onDownload" | "onOpen"
> & {
  attachment: Attachment;
  isActive: boolean;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenPlayback, setFullscreenPlayback] = useState<VideoPlayback | null>(null);
  const inlineVideoRef = useRef<HTMLVideoElement>(null);
  const bilibiliDescription =
    attachment.kind === "link" ? describeBilibiliLink(attachment.value) : null;
  const isMissingMedia = Boolean(
    (attachment.kind === "image" || attachment.kind === "video") &&
      attachment.blobHash &&
      !attachment.value,
  );

  useEffect(() => {
    let cancelled = false;
    if (attachment.kind !== "image" && attachment.kind !== "video") {
      return;
    }
    if (isMissingMedia) {
      setPreviewUrl(null);
      setPreviewError(false);
      return;
    }
    void resolveMediaUrl(attachment)
      .then((url) => {
        if (!cancelled) {
          setPreviewUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, isMissingMedia]);

  useEffect(() => {
    if (!isActive) {
      inlineVideoRef.current?.pause();
    }
    return () => {
      inlineVideoRef.current?.pause();
    };
  }, [isActive]);

  const previewKind =
    attachment.kind === "image" || attachment.kind === "video"
      ? attachment.kind
      : null;

  return (
    <>
      <article className={`attachment-item attachment-item--${attachment.kind}`}>
        {previewKind && previewUrl && !previewError && (
          <div className="attachment-media-preview">
            {attachment.kind === "image" ? (
              <img
                src={previewUrl}
                alt={attachment.title}
                onError={() => setPreviewError(true)}
              />
            ) : (
              <video
                ref={inlineVideoRef}
                src={previewUrl}
                controls
                playsInline
                preload="metadata"
                onError={() => setPreviewError(true)}
              />
            )}
            <button
              type="button"
              className="attachment-fullscreen"
              title={`View ${attachment.title} fullscreen`}
              aria-label={`View ${attachment.title} fullscreen`}
              onClick={() => {
                const video = inlineVideoRef.current;
                setFullscreenPlayback(video ? readVideoPlayback(video) : null);
                video?.pause();
                setIsFullscreen(true);
              }}
            >
              <Maximize2 size={16} />
            </button>
          </div>
        )}
        {previewError && (
          <p className="attachment-preview-error">Preview unavailable</p>
        )}
        {isMissingMedia && (
          <div className="attachment-download">
            <Download size={17} />
            <span>Media is available on a trusted device</span>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onDownload(attachment)}
              disabled={isBusy}
            >
              <Download size={14} />
              Download media
            </button>
          </div>
        )}
        <div className="attachment-item__body">
          <span>
            {attachment.kind === "note" && <StickyNote size={13} />}
            {attachment.kind === "link" && <LinkIcon size={13} />}
            {attachment.kind === "image" && <FileImage size={13} />}
            {attachment.kind === "video" && <Film size={13} />}
            {bilibiliDescription ? "Bilibili video" : attachment.kind}
          </span>
          <strong>{attachment.title}</strong>
          {attachment.kind === "note" && <p>{attachment.value}</p>}
          {attachment.kind === "link" && (
            <button
              type="button"
              className="attachment-link"
              onClick={() => onOpen(attachment)}
            >
              <span>{bilibiliDescription ?? attachment.value}</span>
              <ExternalLink size={12} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="attachment-delete"
          title="Delete source"
          aria-label={`Delete ${attachment.title}`}
          onClick={() => onDelete(attachment)}
          disabled={isBusy}
        >
          <Trash2 size={13} />
        </button>
      </article>
      {isFullscreen && previewUrl && previewKind && (
        <MediaViewer
          kind={previewKind}
          title={attachment.title}
          previewUrl={previewUrl}
          initialPlayback={fullscreenPlayback ?? undefined}
          isActive={isActive}
          onClose={(playback) => {
            setIsFullscreen(false);
            const video = inlineVideoRef.current;
            if (!video || !playback) {
              return;
            }
            seekVideo(video, playback.currentTime);
            if (playback.playing && isActive) {
              resumeVideo(video);
            }
          }}
        />
      )}
    </>
  );
}

export function AttachmentPanel({
  ownerType,
  ownerId,
  attachments,
  isBusy,
  isActive = true,
  onSave,
  onAddMedia,
  onDelete,
  onDownload,
  onOpen,
}: AttachmentPanelProps) {
  const [dialogKind, setDialogKind] = useState<EditableAttachmentKind | null>(null);

  return (
    <section className="inspector-section attachment-section">
      <div className="inspector-section__heading">
        <h3>Sources</h3>
        <span>{attachments.length}</span>
      </div>
      <div className="attachment-actions" aria-label="Add source">
        <button
          type="button"
          title="Add note"
          aria-label="Add note"
          onClick={() => setDialogKind("note")}
          disabled={isBusy}
        >
          <StickyNote size={14} />
        </button>
        <button
          type="button"
          title="Add link"
          aria-label="Add link"
          onClick={() => setDialogKind("link")}
          disabled={isBusy}
        >
          <LinkIcon size={14} />
        </button>
        <button
          type="button"
          title="Import image"
          aria-label="Import image"
          onClick={() => onAddMedia("image")}
          disabled={isBusy}
        >
          <FileImage size={14} />
        </button>
        <button
          type="button"
          title="Import video"
          aria-label="Import video"
          onClick={() => onAddMedia("video")}
          disabled={isBusy}
        >
          <Film size={14} />
        </button>
        <span>
          <Plus size={11} /> Add
        </span>
      </div>
      <div className="attachment-list">
        {attachments.map((attachment) => (
          <AttachmentItem
            key={attachment.id}
            attachment={attachment}
            isBusy={isBusy}
            isActive={isActive}
            onDelete={onDelete}
            onDownload={onDownload}
            onOpen={onOpen}
          />
        ))}
        {attachments.length === 0 && (
          <p className="attachment-empty">No notes, links, images, or videos yet.</p>
        )}
      </div>
      {dialogKind && (
        <AttachmentDialog
          ownerType={ownerType}
          ownerId={ownerId}
          kind={dialogKind}
          isBusy={isBusy}
          onSave={(attachment) => {
            onSave(attachment);
            setDialogKind(null);
          }}
          onOpen={onOpen}
          onClose={() => setDialogKind(null)}
        />
      )}
    </section>
  );
}