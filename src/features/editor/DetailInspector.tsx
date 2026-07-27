import { ArrowRight, Focus, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  Attachment,
  GraphSelection,
  Position,
  Technique,
} from "../../domain/types";
import { AttachmentPanel } from "./AttachmentPanel";

interface DetailInspectorProps {
  selection: GraphSelection;
  positions: Position[];
  techniques: Technique[];
  attachments: Attachment[];
  isBusy: boolean;
  focusSelection: boolean;
  onToggleFocus: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddTechnique: (sourcePositionId: string) => void;
  onSelectTechnique: (techniqueId: string) => void;
  onSaveAttachment: (attachment: Attachment) => void;
  onAddMedia: (
    ownerType: Attachment["ownerType"],
    ownerId: string,
    kind: Extract<Attachment["kind"], "image" | "video">,
  ) => void;
  onDeleteAttachment: (attachment: Attachment) => void;
  onDownloadAttachment: (attachment: Attachment) => void;
  onOpenAttachment: (attachment: Attachment) => void;
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-property">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function DetailInspector({
  selection,
  positions,
  techniques,
  attachments,
  isBusy,
  focusSelection,
  onToggleFocus,
  onEdit,
  onDelete,
  onAddTechnique,
  onSelectTechnique,
  onSaveAttachment,
  onAddMedia,
  onDeleteAttachment,
  onDownloadAttachment,
  onOpenAttachment,
}: DetailInspectorProps) {
  const selectedPosition =
    selection?.type === "position"
      ? positions.find((position) => position.id === selection.id)
      : undefined;
  const selectedTechnique =
    selection?.type === "technique"
      ? techniques.find((technique) => technique.id === selection.id)
      : undefined;

  if (!selectedPosition && !selectedTechnique) {
    return (
      <aside className="detail-inspector detail-inspector--empty">
        <div className="inspector-empty-mark">
          <span />
          <span />
          <span />
        </div>
        <p>No selection</p>
      </aside>
    );
  }

  const entityAttachments = attachments.filter(
    (attachment) => attachment.ownerId === selection?.id,
  );

  if (selectedPosition) {
    const connectedTechniques = techniques.filter(
      (technique) =>
        technique.sourcePositionId === selectedPosition.id ||
        technique.targetPositionId === selectedPosition.id,
    );

    return (
      <aside className="detail-inspector">
        <header className="inspector-header">
          <div>
            <span className={`entity-kicker entity-kicker--${selectedPosition.category}`}>
              {selectedPosition.category}
            </span>
            <h2>{selectedPosition.name}</h2>
            {selectedPosition.aliases.length > 0 && (
              <p className="inspector-aliases">{selectedPosition.aliases.join(" · ")}</p>
            )}
          </div>
          <button
            type="button"
            className={`icon-button${focusSelection ? " is-active" : ""}`}
            title={focusSelection ? "Show full graph" : "Focus neighborhood"}
            aria-label={focusSelection ? "Show full graph" : "Focus neighborhood"}
            onClick={onToggleFocus}
          >
            <Focus size={17} />
          </button>
        </header>

        <div className="inspector-content">
          <p className="inspector-description">
            {selectedPosition.description || "No notes yet."}
          </p>
          <section className="inspector-section">
            <h3>Position</h3>
            <div className="inspector-properties">
              <Property label="Role" value={selectedPosition.role} />
              <Property label="Connections" value={String(connectedTechniques.length)} />
            </div>
          </section>
          <section className="inspector-section">
            <h3>Tags</h3>
            <div className="entity-tags">
              {selectedPosition.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
              {selectedPosition.tags.length === 0 && <small>None</small>}
            </div>
          </section>
          <section className="inspector-section">
            <div className="inspector-section__heading">
              <h3>Transitions</h3>
              <button
                type="button"
                className="icon-button"
                title="Add transition"
                aria-label="Add transition"
                onClick={() => onAddTechnique(selectedPosition.id)}
                disabled={isBusy}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="transition-list">
              {connectedTechniques.map((technique) => (
                <button
                  type="button"
                  key={technique.id}
                  onClick={() => onSelectTechnique(technique.id)}
                >
                  <span>{technique.name}</span>
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </section>
          <AttachmentPanel
            ownerType="position"
            ownerId={selectedPosition.id}
            attachments={entityAttachments}
            isBusy={isBusy}
            onSave={onSaveAttachment}
            onAddMedia={(kind) => onAddMedia("position", selectedPosition.id, kind)}
            onDelete={onDeleteAttachment}
            onDownload={onDownloadAttachment}
            onOpen={onOpenAttachment}
          />
        </div>

        <footer className="inspector-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onEdit}
            disabled={isBusy}
          >
            <Pencil size={15} />
            Edit
          </button>
          <button
            type="button"
            className="icon-button icon-button--danger"
            title="Delete position"
            aria-label="Delete position"
            onClick={onDelete}
            disabled={isBusy}
          >
            <Trash2 size={16} />
          </button>
        </footer>
      </aside>
    );
  }

  const sourcePosition = positions.find(
    (position) => position.id === selectedTechnique?.sourcePositionId,
  );
  const targetPosition = positions.find(
    (position) => position.id === selectedTechnique?.targetPositionId,
  );

  return (
    <aside className="detail-inspector">
      <header className="inspector-header">
        <div>
          <span className="entity-kicker entity-kicker--transition">Transition</span>
          <h2>{selectedTechnique?.name}</h2>
        </div>
        <button
          type="button"
          className={`icon-button${focusSelection ? " is-active" : ""}`}
          title={focusSelection ? "Show full graph" : "Focus endpoints"}
          aria-label={focusSelection ? "Show full graph" : "Focus endpoints"}
          onClick={onToggleFocus}
        >
          <Focus size={17} />
        </button>
      </header>
      <div className="inspector-content">
        <div className="transition-route">
          <span>{sourcePosition?.name ?? "Unknown"}</span>
          <ArrowRight size={16} />
          <span>{targetPosition?.name ?? "Unknown"}</span>
        </div>
        <p className="inspector-description">
          {selectedTechnique?.description || "No notes yet."}
        </p>
        <section className="inspector-section">
          <h3>Method</h3>
          <div className="inspector-properties">
            <Property label="Uniform" value={selectedTechnique?.giMode ?? "both"} />
            <Property
              label="Level"
              value={selectedTechnique?.difficulty ?? "foundation"}
            />
          </div>
        </section>
        <section className="inspector-section">
          <h3>Tags</h3>
          <div className="entity-tags">
            {selectedTechnique?.tags.map((tag) => <span key={tag}>{tag}</span>)}
            {selectedTechnique?.tags.length === 0 && <small>None</small>}
          </div>
        </section>
        {selectedTechnique && (
          <AttachmentPanel
            ownerType="technique"
            ownerId={selectedTechnique.id}
            attachments={entityAttachments}
            isBusy={isBusy}
            onSave={onSaveAttachment}
            onAddMedia={(kind) =>
              onAddMedia("technique", selectedTechnique.id, kind)
            }
            onDelete={onDeleteAttachment}
            onDownload={onDownloadAttachment}
            onOpen={onOpenAttachment}
          />
        )}
      </div>
      <footer className="inspector-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onEdit}
          disabled={isBusy}
        >
          <Pencil size={15} />
          Edit
        </button>
        <button
          type="button"
          className="icon-button icon-button--danger"
          title="Delete transition"
          aria-label="Delete transition"
          onClick={onDelete}
          disabled={isBusy}
        >
          <Trash2 size={16} />
        </button>
      </footer>
    </aside>
  );
}