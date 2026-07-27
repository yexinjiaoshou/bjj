import { invoke, isTauri } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { XYPosition } from "@xyflow/react";
import type {
  Attachment,
  KnowledgeGraph,
  Position,
  Technique,
} from "../domain/types";
import {
  defaultLibrary,
  type KnowledgeLibrary,
} from "./libraryCatalog";

export const emptyGraph: KnowledgeGraph = {
  positions: [],
  techniques: [],
  attachments: [],
};

export interface GraphRepository {
  loadGraph(): Promise<KnowledgeGraph>;
  importGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph>;
  savePosition(position: Position): Promise<void>;
  movePosition(positionId: string, coordinates: XYPosition): Promise<void>;
  saveLayout(positions: Position[]): Promise<void>;
  deletePosition(positionId: string): Promise<void>;
  saveTechnique(technique: Technique): Promise<void>;
  deleteTechnique(techniqueId: string): Promise<void>;
  saveAttachment(attachment: Attachment): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
}

interface PositionRow {
  id: string;
  name: string;
  aliases_json: string;
  description: string;
  category: Position["category"];
  role: Position["role"];
  tags_json: string;
  x: number;
  y: number;
}

interface TechniqueRow {
  id: string;
  source_position_id: string;
  target_position_id: string | null;
  name: string;
  description: string;
  gi_mode: Technique["giMode"];
  difficulty: Technique["difficulty"];
  tags_json: string;
}

interface AttachmentRow {
  id: string;
  owner_type: Attachment["ownerType"];
  owner_id: string;
  kind: Attachment["kind"];
  title: string;
  value: string;
  blob_hash: string | null;
  mime_type: string | null;
  file_extension: string | null;
  byte_size: number | null;
}

type NativeGraphMutation =
  | { type: "importGraph"; graph: KnowledgeGraph }
  | { type: "savePosition"; position: Position }
  | { type: "movePosition"; positionId: string; coordinates: XYPosition }
  | {
      type: "saveLayout";
      positions: Array<{ id: string; x: number; y: number }>;
    }
  | { type: "deletePosition"; positionId: string }
  | { type: "saveTechnique"; technique: Technique }
  | { type: "deleteTechnique"; techniqueId: string }
  | { type: "saveAttachment"; attachment: Attachment }
  | { type: "deleteAttachment"; attachmentId: string };

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function cloneGraph(graph: KnowledgeGraph): KnowledgeGraph {
  return structuredClone(graph);
}

function normalizeLegacyGraph(graph: KnowledgeGraph): KnowledgeGraph {
  return {
    ...graph,
    positions: graph.positions.map((position) => ({
      ...position,
      category:
        (position.category as Position["category"] | "pin") === "pin"
          ? "control"
          : position.category,
    })),
    techniques: graph.techniques.map((technique) => ({
      ...technique,
      targetPositionId: technique.targetPositionId ?? null,
    })),
  };
}

class SqliteGraphRepository implements GraphRepository {
  private databasePromise: Promise<Database> | null = null;

  constructor(private readonly library: KnowledgeLibrary) {}

  private getDatabase() {
    this.databasePromise ??= invoke("prepare_library_database", {
      databaseUrl: this.library.databaseUrl,
    }).then(() => Database.load(this.library.databaseUrl));
    return this.databasePromise;
  }

  private applyMutation(mutation: NativeGraphMutation) {
    return invoke<void>("apply_graph_mutation", {
      databaseUrl: this.library.databaseUrl,
      mutation,
    });
  }

  async loadGraph(): Promise<KnowledgeGraph> {
    const database = await this.getDatabase();
    const [positionRows, techniqueRows, attachmentRows] = await Promise.all([
      database.select<PositionRow[]>("SELECT * FROM positions ORDER BY created_at, id"),
      database.select<TechniqueRow[]>(
        "SELECT * FROM techniques ORDER BY created_at, id",
      ),
      database.select<AttachmentRow[]>(
        `SELECT attachments.id, owner_type, owner_id, kind, title,
                CASE
                  WHEN attachments.blob_hash IS NOT NULL
                  THEN COALESCE(media_blobs.relative_path, '')
                  ELSE attachments.value
                END AS value,
                attachments.blob_hash, attachments.mime_type,
                attachments.file_extension, attachments.byte_size
         FROM attachments
         LEFT JOIN media_blobs ON media_blobs.blob_hash = attachments.blob_hash
         ORDER BY owner_type, owner_id, sort_order, attachments.created_at, attachments.id`,
      ),
    ]);

    return {
      positions: positionRows.map((row) => ({
        id: row.id,
        name: row.name,
        aliases: parseStringArray(row.aliases_json),
        description: row.description,
        category: row.category,
        role: row.role,
        tags: parseStringArray(row.tags_json),
        x: row.x,
        y: row.y,
      })),
      techniques: techniqueRows.map((row) => ({
        id: row.id,
        sourcePositionId: row.source_position_id,
        targetPositionId: row.target_position_id,
        name: row.name,
        description: row.description,
        giMode: row.gi_mode,
        difficulty: row.difficulty,
        tags: parseStringArray(row.tags_json),
      })),
      attachments: attachmentRows.map((row) => ({
        id: row.id,
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        kind: row.kind,
        title: row.title,
        value: row.value,
        blobHash: row.blob_hash,
        mimeType: row.mime_type,
        fileExtension: row.file_extension,
        byteSize: row.byte_size,
      })),
    };
  }

  async importGraph(graph: KnowledgeGraph): Promise<KnowledgeGraph> {
    await this.applyMutation({ type: "importGraph", graph });
    return this.loadGraph();
  }

  async savePosition(position: Position): Promise<void> {
    await this.applyMutation({ type: "savePosition", position });
  }

  async movePosition(positionId: string, coordinates: XYPosition): Promise<void> {
    await this.applyMutation({
      type: "movePosition",
      positionId,
      coordinates: { x: coordinates.x, y: coordinates.y },
    });
  }

  async saveLayout(positions: Position[]): Promise<void> {
    if (positions.length === 0) {
      return;
    }
    await this.applyMutation({
      type: "saveLayout",
      positions: positions.map(({ id, x, y }) => ({ id, x, y })),
    });
  }

  async deletePosition(positionId: string): Promise<void> {
    await this.applyMutation({ type: "deletePosition", positionId });
  }

  async saveTechnique(technique: Technique): Promise<void> {
    await this.applyMutation({ type: "saveTechnique", technique });
  }

  async deleteTechnique(techniqueId: string): Promise<void> {
    await this.applyMutation({ type: "deleteTechnique", techniqueId });
  }

  async saveAttachment(attachment: Attachment): Promise<void> {
    await this.applyMutation({ type: "saveAttachment", attachment });
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    await this.applyMutation({ type: "deleteAttachment", attachmentId });
  }
}

class BrowserGraphRepository implements GraphRepository {
  constructor(private readonly storageKey: string) {}

  private readGraph(): KnowledgeGraph {
    const serialized = window.localStorage.getItem(this.storageKey);
    if (!serialized) {
      return cloneGraph(emptyGraph);
    }
    try {
      const graph = normalizeLegacyGraph(JSON.parse(serialized) as KnowledgeGraph);
      this.writeGraph(graph);
      return graph;
    } catch {
      return cloneGraph(emptyGraph);
    }
  }

  private writeGraph(graph: KnowledgeGraph) {
    window.localStorage.setItem(this.storageKey, JSON.stringify(graph));
  }

  async loadGraph() {
    return this.readGraph();
  }

  async importGraph(graph: KnowledgeGraph) {
    const importedGraph = cloneGraph(graph);
    this.writeGraph(importedGraph);
    return importedGraph;
  }

  async savePosition(position: Position) {
    const graph = this.readGraph();
    graph.positions = graph.positions.some((item) => item.id === position.id)
      ? graph.positions.map((item) => (item.id === position.id ? position : item))
      : [...graph.positions, position];
    this.writeGraph(graph);
  }

  async movePosition(positionId: string, coordinates: XYPosition) {
    const graph = this.readGraph();
    graph.positions = graph.positions.map((position) =>
      position.id === positionId
        ? { ...position, x: coordinates.x, y: coordinates.y }
        : position,
    );
    this.writeGraph(graph);
  }

  async saveLayout(positions: Position[]) {
    const graph = this.readGraph();
    const coordinates = new Map(
      positions.map((position) => [position.id, { x: position.x, y: position.y }]),
    );
    graph.positions = graph.positions.map((position) => {
      const nextCoordinates = coordinates.get(position.id);
      return nextCoordinates ? { ...position, ...nextCoordinates } : position;
    });
    this.writeGraph(graph);
  }

  async deletePosition(positionId: string) {
    const graph = this.readGraph();
    const techniqueIds = new Set(
      graph.techniques
        .filter(
          (technique) =>
            technique.sourcePositionId === positionId ||
            technique.targetPositionId === positionId,
        )
        .map((technique) => technique.id),
    );
    graph.positions = graph.positions.filter((position) => position.id !== positionId);
    graph.techniques = graph.techniques.filter(
      (technique) => !techniqueIds.has(technique.id),
    );
    graph.attachments = graph.attachments.filter(
      (attachment) =>
        attachment.ownerId !== positionId && !techniqueIds.has(attachment.ownerId),
    );
    this.writeGraph(graph);
  }

  async saveTechnique(technique: Technique) {
    const graph = this.readGraph();
    graph.techniques = graph.techniques.some((item) => item.id === technique.id)
      ? graph.techniques.map((item) => (item.id === technique.id ? technique : item))
      : [...graph.techniques, technique];
    this.writeGraph(graph);
  }

  async deleteTechnique(techniqueId: string) {
    const graph = this.readGraph();
    graph.techniques = graph.techniques.filter(
      (technique) => technique.id !== techniqueId,
    );
    graph.attachments = graph.attachments.filter(
      (attachment) => attachment.ownerId !== techniqueId,
    );
    this.writeGraph(graph);
  }

  async saveAttachment(attachment: Attachment) {
    const graph = this.readGraph();
    graph.attachments = graph.attachments.some((item) => item.id === attachment.id)
      ? graph.attachments.map((item) =>
          item.id === attachment.id ? attachment : item,
        )
      : [...graph.attachments, attachment];
    this.writeGraph(graph);
  }

  async deleteAttachment(attachmentId: string) {
    const graph = this.readGraph();
    graph.attachments = graph.attachments.filter(
      (attachment) => attachment.id !== attachmentId,
    );
    this.writeGraph(graph);
  }
}

const repositories = new Map<string, GraphRepository>();

export function getGraphRepository(
  library: KnowledgeLibrary = defaultLibrary,
): GraphRepository {
  const repositoryKey = isTauri()
    ? library.databaseUrl
    : library.browserStorageKey;
  const existingRepository = repositories.get(repositoryKey);
  if (existingRepository) {
    return existingRepository;
  }
  const repository = isTauri()
    ? new SqliteGraphRepository(library)
    : new BrowserGraphRepository(library.browserStorageKey);
  repositories.set(repositoryKey, repository);
  return repository;
}