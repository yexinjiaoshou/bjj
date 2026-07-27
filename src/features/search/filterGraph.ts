import type {
  Difficulty,
  GiMode,
  KnowledgeGraph,
  PositionCategory,
  PositionRole,
} from "../../domain/types";

export type CategoryFilter = PositionCategory | "all";
export type RoleFilter = PositionRole | "all";
export type GiModeFilter = GiMode | "all";
export type DifficultyFilter = Difficulty | "all";

export interface GraphFilters {
  category: CategoryFilter;
  role: RoleFilter;
  giMode: GiModeFilter;
  difficulty: DifficultyFilter;
  tag: string | null;
}

function matchesCompatibleValue<T extends string>(
  value: T,
  filter: T | "all",
  sharedValue: T,
) {
  return filter === "all" || value === filter || (filter !== sharedValue && value === sharedValue);
}

export function filterGraph(graph: KnowledgeGraph, filters: GraphFilters): KnowledgeGraph {
  const matchingTechniques = graph.techniques.filter(
    (technique) =>
      matchesCompatibleValue(technique.giMode, filters.giMode, "both") &&
      (filters.difficulty === "all" || technique.difficulty === filters.difficulty) &&
      (!filters.tag || technique.tags.includes(filters.tag)),
  );

  const taggedTechniqueEndpoints = new Set<string>();
  if (filters.tag) {
    matchingTechniques.forEach((technique) => {
      taggedTechniqueEndpoints.add(technique.sourcePositionId);
      if (technique.targetPositionId) {
        taggedTechniqueEndpoints.add(technique.targetPositionId);
      }
    });
  }

  const positions = graph.positions.filter(
    (position) =>
      (filters.category === "all" || position.category === filters.category) &&
      (filters.role === "all" || position.role === filters.role) &&
      (!filters.tag ||
        position.tags.includes(filters.tag) ||
        taggedTechniqueEndpoints.has(position.id)),
  );
  const visiblePositionIds = new Set(positions.map((position) => position.id));
  const techniques = matchingTechniques.filter(
    (technique) =>
      visiblePositionIds.has(technique.sourcePositionId) &&
      (technique.targetPositionId === null ||
        visiblePositionIds.has(technique.targetPositionId)),
  );

  return { positions, techniques, attachments: graph.attachments };
}