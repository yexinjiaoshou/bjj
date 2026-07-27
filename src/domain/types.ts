export type PositionCategory =
  | "standing"
  | "guard"
  | "control"
  | "submission";

export type PositionRole = "top" | "bottom" | "neutral";

export type GiMode = "gi" | "nogi" | "both";

export type Difficulty = "foundation" | "intermediate" | "advanced";

export type AttachmentKind = "note" | "image" | "video" | "link";

export interface Attachment {
  id: string;
  ownerType: "position" | "technique";
  ownerId: string;
  kind: AttachmentKind;
  title: string;
  value: string;
  blobHash?: string | null;
  mimeType?: string | null;
  fileExtension?: string | null;
  byteSize?: number | null;
}

export interface Position {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  category: PositionCategory;
  role: PositionRole;
  tags: string[];
  x: number;
  y: number;
}

export interface Technique {
  id: string;
  sourcePositionId: string;
  targetPositionId: string | null;
  name: string;
  description: string;
  giMode: GiMode;
  difficulty: Difficulty;
  tags: string[];
}

export type GraphSelection =
  | { type: "position"; id: string }
  | { type: "technique"; id: string }
  | null;

export interface KnowledgeGraph {
  positions: Position[];
  techniques: Technique[];
  attachments: Attachment[];
}