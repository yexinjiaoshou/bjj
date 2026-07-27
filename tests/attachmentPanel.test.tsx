import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ inspectBilibiliLink: vi.fn() }));

vi.mock("../src/services/bilibili", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/bilibili")>()),
  inspectBilibiliLink: native.inspectBilibiliLink,
}));

import { AttachmentPanel } from "../src/features/editor/AttachmentPanel";

beforeEach(() => {
  vi.clearAllMocks();
  delete window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__;
});

function renderPanel(overrides: Partial<Parameters<typeof AttachmentPanel>[0]> = {}) {
  const props = {
    ownerType: "technique" as const,
    ownerId: "technique-1",
    attachments: [],
    isBusy: false,
    onSave: vi.fn(),
    onAddMedia: vi.fn(),
    onDelete: vi.fn(),
    onDownload: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
  render(<AttachmentPanel {...props} />);
  return props;
}

describe("attachment links", () => {
  it("recognizes pasted Bilibili share text and saves an exact-time page link", async () => {
    const user = userEvent.setup();
    native.inspectBilibiliLink.mockResolvedValue({
      bvid: "BV1B7411m7LV",
      title: "Guard passing seminar",
      owner: "Coach",
      durationSeconds: 300,
      selectedPage: 1,
      startSeconds: 5,
      pages: [
        { page: 1, cid: 101, part: "Headquarters", durationSeconds: 120 },
        { page: 2, cid: 102, part: "Knee cut", durationSeconds: 180 },
      ],
    });
    const props = renderPanel();

    await user.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.paste(screen.getByLabelText("URL"), {
      clipboardData: {
        getData: () => "分享视频 https://b23.tv/AbCd12 复制打开哔哩哔哩",
      },
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Title")).toHaveValue(
        "Guard passing seminar · Headquarters",
      ),
    );
    expect(screen.getByTitle("Bilibili preview: Guard passing seminar")).toHaveAttribute(
      "src",
      expect.stringContaining("p=1&t=5"),
    );
    await user.selectOptions(screen.getByLabelText("Video part"), "2");
    expect(screen.getByLabelText("Title")).toHaveValue(
      "Guard passing seminar · Knee cut",
    );
    expect(screen.getByTitle("Bilibili preview: Guard passing seminar")).toHaveAttribute(
      "src",
      expect.stringContaining("p=2&t=5"),
    );
    fireEvent.change(screen.getByLabelText("Preview time"), {
      target: { value: "83" },
    });
    expect(screen.getByLabelText("Start time")).toHaveValue("1:23");
    expect(screen.getByTitle("Bilibili preview: Guard passing seminar")).toHaveAttribute(
      "src",
      expect.stringContaining("p=2&t=5"),
    );
    fireEvent.pointerUp(screen.getByLabelText("Preview time"));
    expect(screen.getByTitle("Bilibili preview: Guard passing seminar")).toHaveAttribute(
      "src",
      expect.stringContaining("p=2&t=83"),
    );
    await user.click(screen.getByRole("button", { name: "Forward 5 seconds" }));
    expect(screen.getByLabelText("Start time")).toHaveValue("1:28");
    expect(screen.getByTitle("Bilibili preview: Guard passing seminar")).toHaveAttribute(
      "src",
      expect.stringContaining("p=2&t=88"),
    );
    await user.click(screen.getByRole("button", { name: "Back 5 seconds" }));
    expect(screen.getByLabelText("Start time")).toHaveValue("1:23");
    await user.clear(screen.getByLabelText("Start time"));
    await user.type(screen.getByLabelText("Start time"), "1:23");
    await user.click(screen.getByRole("button", { name: "Test open" }));
    expect(props.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "https://www.bilibili.com/video/BV1B7411m7LV/?p=2&t=83",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Add source" }));
    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "link",
        title: "Guard passing seminar · Knee cut",
        value: "https://www.bilibili.com/video/BV1B7411m7LV/?p=2&t=83",
      }),
    );
  });

  it("keeps a Bilibili short link saveable when metadata is unavailable", async () => {
    const user = userEvent.setup();
    native.inspectBilibiliLink.mockRejectedValue(new Error("Network unavailable"));
    const props = renderPanel();

    await user.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.paste(screen.getByLabelText("URL"), {
      clipboardData: { getData: () => "https://b23.tv/AbCd12" },
    });
    expect(await screen.findByText("Network unavailable")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Title"), "Passing reference");
    await user.click(screen.getByRole("button", { name: "Add source" }));

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Passing reference",
        value: "https://b23.tv/AbCd12",
      }),
    );
  });

  it("shows saved Bilibili page and timestamp details", () => {
    renderPanel({
      attachments: [
        {
          id: "link-1",
          ownerType: "technique",
          ownerId: "technique-1",
          kind: "link",
          title: "Knee cut detail",
          value: "https://www.bilibili.com/video/BV1B7411m7LV/?p=2&t=83",
        },
      ],
    });

    expect(screen.getByText("Bilibili video")).toBeInTheDocument();
    expect(screen.getByText("Bilibili · P2 · 1:23")).toBeInTheDocument();
  });
});

describe("attachment media", () => {
  it.each([
    { kind: "image" as const, extension: "jpg", mimeType: "image/jpeg" },
    { kind: "video" as const, extension: "m4v", mimeType: "video/mp4" },
  ])("opens $kind attachments fullscreen and closes them from Android back", async ({
    kind,
    extension,
    mimeType,
  }) => {
    const user = userEvent.setup();
    const attachment = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      ownerType: "technique" as const,
      ownerId: "technique-1",
      kind,
      title: `Guard retention ${kind}`,
      value: `media/550e8400-e29b-41d4-a716-446655440000.${extension}`,
      mimeType,
      fileExtension: extension,
    };
    renderPanel({ attachments: [attachment] });

    await user.click(
      await screen.findByRole("button", {
        name: `View ${attachment.title} fullscreen`,
      }),
    );

    const viewer = screen.getByRole("dialog", {
      name: `Fullscreen preview: ${attachment.title}`,
    });
    expect(viewer.querySelector(kind === "image" ? "img" : "video")).toHaveAttribute(
      "src",
      attachment.value,
    );
    expect(window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__?.()).toBe(true);
    await waitFor(() => expect(viewer).not.toBeInTheDocument());
  });

  it("offers an on-demand download for a missing content object", async () => {
    const user = userEvent.setup();
    const attachment = {
      id: "media-1",
      ownerType: "technique" as const,
      ownerId: "technique-1",
      kind: "video" as const,
      title: "Guard retention",
      value: "",
      blobHash: "a".repeat(64),
      mimeType: "video/mp4",
      fileExtension: "m4v",
      byteSize: 4096,
    };
    const props = renderPanel({ attachments: [attachment] });

    await user.click(screen.getByRole("button", { name: "Download media" }));
    expect(props.onDownload).toHaveBeenCalledWith(attachment);
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
  });
});