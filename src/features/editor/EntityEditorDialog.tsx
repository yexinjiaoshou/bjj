import { X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { Position, Technique } from "../../domain/types";

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

interface DialogFrameProps {
  title: string;
  eyebrow: string;
  children: ReactNode;
  onClose: () => void;
}

function DialogFrame({ title, eyebrow, children, onClose }: DialogFrameProps) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="entity-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="entity-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{eyebrow}</span>
            <h2 id="entity-dialog-title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

interface PositionEditorDialogProps {
  position: Position;
  isNew: boolean;
  isSaving?: boolean;
  onSave: (position: Position) => void;
  onClose: () => void;
}

export function PositionEditorDialog({
  position,
  isNew,
  isSaving = false,
  onSave,
  onClose,
}: PositionEditorDialogProps) {
  const [draft, setDraft] = useState(position);
  const [aliases, setAliases] = useState(position.aliases.join(", "));
  const [tags, setTags] = useState(position.tags.join(", "));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      return;
    }
    onSave({ ...draft, name, aliases: splitList(aliases), tags: splitList(tags) });
  }

  return (
    <DialogFrame
      title={isNew ? "New position" : "Edit position"}
      eyebrow="Position"
      onClose={onClose}
    >
      <form className="entity-form" onSubmit={handleSubmit}>
        <label className="field field--wide">
          <span>Name</span>
          <input
            autoFocus
            required
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. Butterfly Guard"
          />
        </label>
        <label className="field field--wide">
          <span>Category</span>
          <select
            value={draft.category}
            onChange={(event) =>
              setDraft({
                ...draft,
                category: event.target.value as Position["category"],
              })
            }
          >
            <option value="standing">Standing</option>
            <option value="guard">Guard</option>
            <option value="control">Control</option>
            <option value="submission">Submission</option>
          </select>
        </label>
        <fieldset className="field field--wide">
          <legend>Role</legend>
          <div className="segmented-control">
            {(["neutral", "top", "bottom"] as const).map((role) => (
              <label key={role}>
                <input
                  type="radio"
                  name="role"
                  value={role}
                  checked={draft.role === role}
                  onChange={() => setDraft({ ...draft, role })}
                />
                <span>{role}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field field--wide">
          <span>Aliases</span>
          <input
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="Comma separated"
          />
        </label>
        <label className="field field--wide">
          <span>Notes</span>
          <textarea
            rows={4}
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
            placeholder="Key controls, risks, and goals"
          />
        </label>
        <label className="field field--wide">
          <span>Tags</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="guard, pressure, favorite"
          />
        </label>
        <footer className="form-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Saving..." : isNew ? "Add position" : "Save changes"}
          </button>
        </footer>
      </form>
    </DialogFrame>
  );
}

interface TechniqueEditorDialogProps {
  technique: Technique;
  positions: Position[];
  isNew: boolean;
  isSaving?: boolean;
  onSave: (technique: Technique) => void;
  onClose: () => void;
}

export function TechniqueEditorDialog({
  technique,
  positions,
  isNew,
  isSaving = false,
  onSave,
  onClose,
}: TechniqueEditorDialogProps) {
  const [draft, setDraft] = useState(technique);
  const [tags, setTags] = useState(technique.tags.join(", "));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.name.trim();
    if (
      !name ||
      (draft.targetPositionId !== null &&
        draft.sourcePositionId === draft.targetPositionId)
    ) {
      return;
    }
    onSave({ ...draft, name, tags: splitList(tags) });
  }

  return (
    <DialogFrame
      title={isNew ? "New transition" : "Edit transition"}
      eyebrow="Technique"
      onClose={onClose}
    >
      <form className="entity-form" onSubmit={handleSubmit}>
        <label className="field field--wide">
          <span>Name</span>
          <input
            autoFocus
            required
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="e.g. Butterfly Sweep"
          />
        </label>
        <label className="field">
          <span>From</span>
          <select
            value={draft.sourcePositionId}
            onChange={(event) =>
              setDraft({ ...draft, sourcePositionId: event.target.value })
            }
          >
            {positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>To</span>
          <select
            value={draft.targetPositionId ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                targetPositionId: event.target.value || null,
              })
            }
          >
            <option value="">Unknown (set later)</option>
            {positions.map((position) => (
              <option key={position.id} value={position.id}>
                {position.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field field--wide">
          <legend>Uniform</legend>
          <div className="segmented-control">
            {(["both", "gi", "nogi"] as const).map((giMode) => (
              <label key={giMode}>
                <input
                  type="radio"
                  name="giMode"
                  value={giMode}
                  checked={draft.giMode === giMode}
                  onChange={() => setDraft({ ...draft, giMode })}
                />
                <span>{giMode === "nogi" ? "No-Gi" : giMode}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field field--wide">
          <span>Difficulty</span>
          <select
            value={draft.difficulty}
            onChange={(event) =>
              setDraft({
                ...draft,
                difficulty: event.target.value as Technique["difficulty"],
              })
            }
          >
            <option value="foundation">Foundation</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label className="field field--wide">
          <span>Notes</span>
          <textarea
            rows={4}
            value={draft.description}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value })
            }
            placeholder="Frames, grips, timing, and common reactions"
          />
        </label>
        <label className="field field--wide">
          <span>Tags</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="sweep, pass, escape"
          />
        </label>
        {draft.targetPositionId !== null &&
          draft.sourcePositionId === draft.targetPositionId && (
          <p className="form-error">Choose two different positions.</p>
          )}
        <footer className="form-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? "Saving..." : isNew ? "Add transition" : "Save changes"}
          </button>
        </footer>
      </form>
    </DialogFrame>
  );
}