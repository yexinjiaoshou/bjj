import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VideoImportDialog } from "../src/features/editor/VideoImportDialog";

describe("video import dialog", () => {
  it("defaults to compact full-video import and enables clipping after preview", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { container } = render(
      <VideoImportDialog
        draft={{
          id: "video-1",
          ownerType: "position",
          ownerId: "position-1",
          title: "Guard retention",
          mediaDirectory: "media",
          sourceRelativePath: "media/staging/video-1.mp4",
          previewUrl: "asset://preview",
        }}
        isBusy={false}
        canCancelWhileBusy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Video storage quality")).toHaveValue("compact");
    const clipMode = screen.getByRole("radio", { name: "Clip" });
    expect(clipMode).toBeDisabled();

    const video = container.querySelector("video") as HTMLVideoElement;
    const preview = video.closest(".video-import-preview");
    const settings = container.querySelector(".video-import-settings");
    expect(preview?.parentElement).toBe(settings?.parentElement);
    expect(settings).not.toContainElement(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);
    expect(clipMode).toBeEnabled();
    await user.click(clipMode);
    fireEvent.change(screen.getByLabelText("Clip start"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Clip end"), { target: { value: "25" } });
    await user.selectOptions(screen.getByLabelText("Video storage quality"), "high");
    await user.click(screen.getByRole("button", { name: "Import video" }));

    expect(onConfirm).toHaveBeenCalledWith({
      quality: "high",
      startSeconds: 10,
      endSeconds: 25,
    });
  });

  it("allows Android users to cancel active processing", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <VideoImportDialog
        draft={{
          id: "video-1",
          ownerType: "position",
          ownerId: "position-1",
          title: "Guard retention",
          mediaDirectory: "media",
          databaseUrl: "sqlite:rollmap.db",
          sourceRelativePath: "media/staging/video-1.mp4",
          previewUrl: "asset://preview",
        }}
        isBusy
        canCancelWhileBusy
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Processing video..." })).toBeDisabled();
  });
});