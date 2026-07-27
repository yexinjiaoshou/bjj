import { beforeEach, describe, expect, it } from "vitest";
import { getGraphRepository } from "../src/data/graphRepository";
import { defaultLibrary } from "../src/data/libraryCatalog";
import { sampleGraph } from "../src/domain/sampleData";
import type { Attachment } from "../src/domain/types";

describe("browser graph repository", () => {
  const repository = getGraphRepository();

  beforeEach(() => window.localStorage.clear());

  it("persists imported data, dragged positions, and a full layout", async () => {
    await repository.importGraph(sampleGraph);
    await repository.movePosition("standing", { x: 41, y: 73 });

    const movedGraph = await repository.loadGraph();
    expect(movedGraph.positions.find((position) => position.id === "standing")).toMatchObject({
      x: 41,
      y: 73,
    });

    const layout = movedGraph.positions.map((position, index) => ({
      ...position,
      x: index * 100,
      y: index * 80,
    }));
    await repository.saveLayout(layout);
    expect((await repository.loadGraph()).positions).toEqual(layout);
  });

  it("persists attachments and cascades them with a deleted position", async () => {
    await repository.importGraph(sampleGraph);
    const attachment: Attachment = {
      id: "standing-note",
      ownerType: "position",
      ownerId: "standing",
      kind: "note",
      title: "Entry cue",
      value: "Keep posture aligned.",
    };
    await repository.saveAttachment(attachment);
    expect((await repository.loadGraph()).attachments).toContainEqual(attachment);

    await repository.deletePosition("standing");
    const graph = await repository.loadGraph();
    expect(graph.positions).toHaveLength(5);
    expect(graph.techniques).toHaveLength(5);
    expect(graph.attachments).toEqual([]);
  });

  it("persists an unknown target and later resolves it to a position", async () => {
    await repository.importGraph(sampleGraph);
    const unresolved = {
      ...sampleGraph.techniques[0],
      id: "unresolved-transition",
      targetPositionId: null,
      name: "Unknown follow-up",
    };

    await repository.saveTechnique(unresolved);
    expect(
      (await repository.loadGraph()).techniques.find(
        (technique) => technique.id === unresolved.id,
      )?.targetPositionId,
    ).toBeNull();

    await repository.saveTechnique({
      ...unresolved,
      targetPositionId: "closed-guard",
    });
    expect(
      (await repository.loadGraph()).techniques.find(
        (technique) => technique.id === unresolved.id,
      )?.targetPositionId,
    ).toBe("closed-guard");
  });

  it("keeps a newly created database isolated from the default database", async () => {
    const secondaryRepository = getGraphRepository({
      id: "secondary",
      syncLibraryId: "d39db2db-2e0d-448f-94ca-d6523f9c480d",
      name: "Secondary",
      databaseUrl: "sqlite:secondary.db",
      mediaDirectory: "media/secondary",
      browserStorageKey: "rollmap.graph.library.secondary",
    });
    await repository.importGraph(sampleGraph);

    expect(await secondaryRepository.loadGraph()).toEqual({
      positions: [],
      techniques: [],
      attachments: [],
    });
    expect((await getGraphRepository(defaultLibrary).loadGraph()).positions).toHaveLength(6);
  });
});