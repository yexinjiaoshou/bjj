import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  load: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => true,
}));

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: native.load },
}));

import { getGraphRepository } from "../src/data/graphRepository";
import type { Attachment, Position, Technique } from "../src/domain/types";

const library = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  syncLibraryId: "550e8400-e29b-41d4-a716-446655440000",
  name: "Native test",
  databaseUrl: "sqlite:native-test.db",
  mediaDirectory: "media/550e8400-e29b-41d4-a716-446655440000",
  browserStorageKey:
    "rollmap.graph.library.550e8400-e29b-41d4-a716-446655440000",
};

const position: Position = {
  id: "p1",
  name: "Closed guard",
  aliases: [],
  description: "",
  category: "guard",
  role: "bottom",
  tags: [],
  x: 10,
  y: 20,
};

const technique: Technique = {
  id: "t1",
  sourcePositionId: "p1",
  targetPositionId: null,
  name: "Unknown follow-up",
  description: "",
  giMode: "both",
  difficulty: "foundation",
  tags: [],
};

const attachment: Attachment = {
  id: "a1",
  ownerType: "position",
  ownerId: "p1",
  kind: "note",
  title: "Cue",
  value: "Control posture",
};

describe("native graph repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.invoke.mockResolvedValue(undefined);
    native.select.mockResolvedValue([]);
    native.load.mockResolvedValue({ select: native.select });
  });

  it("routes every graph write through the native transactional command", async () => {
    const repository = getGraphRepository(library);

    await repository.savePosition(position);
    await repository.movePosition(position.id, { x: 30, y: 40 });
    await repository.saveLayout([{ ...position, x: 50, y: 60 }]);
    await repository.saveTechnique(technique);
    await repository.saveAttachment(attachment);
    await repository.deleteAttachment(attachment.id);
    await repository.deleteTechnique(technique.id);
    await repository.deletePosition(position.id);

    expect(native.invoke.mock.calls).toEqual([
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "savePosition", position },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: {
          type: "movePosition",
          positionId: position.id,
          coordinates: { x: 30, y: 40 },
        },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: {
          type: "saveLayout",
          positions: [{ id: position.id, x: 50, y: 60 }],
        },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "saveTechnique", technique },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "saveAttachment", attachment },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "deleteAttachment", attachmentId: attachment.id },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "deleteTechnique", techniqueId: technique.id },
      }],
      ["apply_graph_mutation", {
        databaseUrl: library.databaseUrl,
        mutation: { type: "deletePosition", positionId: position.id },
      }],
    ]);
    expect(native.load).not.toHaveBeenCalled();
  });

  it("imports in one mutation and still reads through the SQL plugin", async () => {
    const repository = getGraphRepository({
      ...library,
      id: "6e6403ae-ff87-47ad-8f75-cfd7866fc04a",
      syncLibraryId: "6e6403ae-ff87-47ad-8f75-cfd7866fc04a",
      databaseUrl: "sqlite:native-import-test.db",
    });
    const graph = {
      positions: [position],
      techniques: [technique],
      attachments: [attachment],
    };

    await expect(repository.importGraph(graph)).resolves.toEqual({
      positions: [],
      techniques: [],
      attachments: [],
    });

    expect(native.invoke).toHaveBeenNthCalledWith(1, "apply_graph_mutation", {
      databaseUrl: "sqlite:native-import-test.db",
      mutation: { type: "importGraph", graph },
    });
    expect(native.invoke).toHaveBeenNthCalledWith(2, "prepare_library_database", {
      databaseUrl: "sqlite:native-import-test.db",
    });
    expect(native.load).toHaveBeenCalledWith("sqlite:native-import-test.db");
    expect(native.select).toHaveBeenCalledTimes(3);
  });
});