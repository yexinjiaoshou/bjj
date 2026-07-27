import type {
  Difficulty,
  GiMode,
  KnowledgeGraph,
  PositionCategory,
  PositionRole,
} from "../../src/domain/types";

const categories: PositionCategory[] = [
  "standing",
  "guard",
  "control",
  "submission",
];
const roles: PositionRole[] = ["neutral", "bottom", "top"];
const giModes: GiMode[] = ["both", "gi", "nogi"];
const difficulties: Difficulty[] = ["foundation", "intermediate", "advanced"];

export function createLargeGraph(
  positionCount = 200,
  techniqueCount = 500,
): KnowledgeGraph {
  const positions = Array.from({ length: positionCount }, (_, index) => ({
    id: `position-${index}`,
    name: `Position ${index + 1}`,
    aliases: [`P${index + 1}`],
    description: `Generated position ${index + 1}`,
    category: categories[index % categories.length],
    role: roles[index % roles.length],
    tags: [`group-${index % 10}`],
    x: (index % 20) * 180,
    y: Math.floor(index / 20) * 130,
  }));
  const techniques = Array.from({ length: techniqueCount }, (_, index) => {
    const sourceIndex = index % positionCount;
    const targetOffset = 1 + Math.floor(index / positionCount) * 13;
    const targetIndex = (sourceIndex + targetOffset) % positionCount;
    return {
      id: `technique-${index}`,
      sourcePositionId: `position-${sourceIndex}`,
      targetPositionId: `position-${targetIndex}`,
      name: `Technique ${index + 1}`,
      description: `Generated transition ${index + 1}`,
      giMode: giModes[index % giModes.length],
      difficulty: difficulties[index % difficulties.length],
      tags: [`system-${index % 12}`],
    };
  });

  return { positions, techniques, attachments: [] };
}