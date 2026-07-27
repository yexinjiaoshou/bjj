import { ArrowRight, CircleDot, Hash, Layers3, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import type {
  GraphSelection,
  Position,
  Technique,
} from "../../domain/types";
import type {
  CategoryFilter,
  DifficultyFilter,
  GiModeFilter,
  RoleFilter,
} from "./filterGraph";

interface LibrarySidebarProps {
  positions: Position[];
  techniques: Technique[];
  query: string;
  category: CategoryFilter;
  role: RoleFilter;
  giMode: GiModeFilter;
  difficulty: DifficultyFilter;
  activeTag: string | null;
  onCategoryChange: (category: CategoryFilter) => void;
  onRoleChange: (role: RoleFilter) => void;
  onGiModeChange: (giMode: GiModeFilter) => void;
  onDifficultyChange: (difficulty: DifficultyFilter) => void;
  onTagChange: (tag: string | null) => void;
  onSelect: (selection: GraphSelection) => void;
}

const categories: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All positions" },
  { value: "standing", label: "Standing" },
  { value: "guard", label: "Guards" },
  { value: "control", label: "Controls" },
  { value: "submission", label: "Submissions" },
];

function includesQuery(values: string[], query: string) {
  return values.some((value) => value.toLocaleLowerCase().includes(query));
}

export function LibrarySidebar({
  positions,
  techniques,
  query,
  category,
  role,
  giMode,
  difficulty,
  activeTag,
  onCategoryChange,
  onRoleChange,
  onGiModeChange,
  onDifficultyChange,
  onTagChange,
  onSelect,
}: LibrarySidebarProps) {
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    [...positions, ...techniques].forEach((item) => {
      item.tags.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1));
    });
    return [...counts.entries()].sort((first, second) =>
      first[0].localeCompare(second[0]),
    );
  }, [positions, techniques]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingPositions = normalizedQuery
    ? positions.filter((position) =>
        includesQuery(
          [
            position.name,
            position.description,
            ...position.aliases,
            ...position.tags,
          ],
          normalizedQuery,
        ),
      )
    : [];
  const matchingTechniques = normalizedQuery
    ? techniques.filter((technique) =>
        includesQuery(
          [technique.name, technique.description, ...technique.tags],
          normalizedQuery,
        ),
      )
    : [];

  return (
    <aside className="library-sidebar">
      {normalizedQuery ? (
        <section className="sidebar-section search-results" aria-label="Search results">
          <div className="sidebar-section__heading">
            <span>Results</span>
            <small>{matchingPositions.length + matchingTechniques.length}</small>
          </div>
          <div className="search-results__group">
            <p>Positions</p>
            {matchingPositions.map((position) => (
              <button
                type="button"
                className="search-result"
                key={position.id}
                onClick={() => onSelect({ type: "position", id: position.id })}
              >
                <CircleDot size={15} />
                <span>
                  <strong>{position.name}</strong>
                  <small>{position.category}</small>
                </span>
              </button>
            ))}
            {matchingPositions.length === 0 && <span className="empty-label">No positions</span>}
          </div>
          <div className="search-results__group">
            <p>Transitions</p>
            {matchingTechniques.map((technique) => (
              <button
                type="button"
                className="search-result"
                key={technique.id}
                onClick={() => onSelect({ type: "technique", id: technique.id })}
              >
                <ArrowRight size={15} />
                <span>
                  <strong>{technique.name}</strong>
                  <small>{technique.giMode}</small>
                </span>
              </button>
            ))}
            {matchingTechniques.length === 0 && (
              <span className="empty-label">No transitions</span>
            )}
          </div>
        </section>
      ) : (
        <>
          <section className="sidebar-section">
            <div className="sidebar-section__heading">
              <span>Library</span>
              <Layers3 size={15} />
            </div>
            <nav className="filter-list" aria-label="Position categories">
              {categories.map((item) => {
                const count =
                  item.value === "all"
                    ? positions.length
                    : positions.filter((position) => position.category === item.value)
                        .length;
                return (
                  <button
                    type="button"
                    key={item.value}
                    className={category === item.value ? "is-active" : ""}
                    onClick={() => onCategoryChange(item.value)}
                  >
                    <span>{item.label}</span>
                    <small>{count}</small>
                  </button>
                );
              })}
            </nav>
          </section>
          <section className="sidebar-section sidebar-section--structured">
            <div className="sidebar-section__heading">
              <span>Attributes</span>
              <SlidersHorizontal size={15} />
            </div>
            <div className="structured-filter-grid">
              <label>
                <span>Role</span>
                <select
                  aria-label="Position role"
                  value={role}
                  onChange={(event) => onRoleChange(event.target.value as RoleFilter)}
                >
                  <option value="all">All roles</option>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                  <option value="neutral">Neutral</option>
                </select>
              </label>
              <label>
                <span>Uniform</span>
                <select
                  aria-label="Gi mode"
                  value={giMode}
                  onChange={(event) => onGiModeChange(event.target.value as GiModeFilter)}
                >
                  <option value="all">All modes</option>
                  <option value="gi">Gi</option>
                  <option value="nogi">No-Gi</option>
                  <option value="both">Both</option>
                </select>
              </label>
              <label>
                <span>Level</span>
                <select
                  aria-label="Difficulty"
                  value={difficulty}
                  onChange={(event) =>
                    onDifficultyChange(event.target.value as DifficultyFilter)
                  }
                >
                  <option value="all">All levels</option>
                  <option value="foundation">Foundation</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
              </label>
            </div>
          </section>
          <section className="sidebar-section sidebar-section--tags">
            <div className="sidebar-section__heading">
              <span>Tags</span>
              <Hash size={15} />
            </div>
            <div className="tag-filter-list">
              {tags.map(([tag, count]) => (
                <button
                  type="button"
                  key={tag}
                  className={activeTag === tag ? "is-active" : ""}
                  onClick={() => onTagChange(activeTag === tag ? null : tag)}
                >
                  <span>{tag}</span>
                  <small>{count}</small>
                </button>
              ))}
            </div>
          </section>
        </>
      )}
      <footer className="library-sidebar__footer">
        <span>{positions.length} positions</span>
        <span>{techniques.length} transitions</span>
      </footer>
    </aside>
  );
}