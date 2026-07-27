import { Database, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { KnowledgeLibrary } from "../../data/libraryCatalog";

interface LibrarySwitcherProps {
  libraries: KnowledgeLibrary[];
  activeLibraryId: string;
  isBusy: boolean;
  onChange: (libraryId: string) => void;
  onCreate: (name: string) => Promise<boolean>;
  onRename: (libraryId: string, name: string) => Promise<boolean>;
  onDelete: (libraryId: string) => Promise<boolean>;
}

export function LibrarySwitcher({
  libraries,
  activeLibraryId,
  isBusy,
  onChange,
  onCreate,
  onRename,
  onDelete,
}: LibrarySwitcherProps) {
  const [dialogMode, setDialogMode] = useState<"create" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const activeLibrary =
    libraries.find((library) => library.id === activeLibraryId) ?? libraries[0];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }
    setIsSaving(true);
    const saved =
      dialogMode === "rename"
        ? await onRename(activeLibraryId, trimmedName)
        : await onCreate(trimmedName);
    setIsSaving(false);
    if (saved) {
      setName("");
      setDialogMode(null);
    }
  }

  async function handleDelete() {
    if (
      activeLibraryId === "default" ||
      !window.confirm(`Delete "${activeLibrary.name}" from this device?`)
    ) {
      return;
    }
    setIsSaving(true);
    await onDelete(activeLibraryId);
    setIsSaving(false);
  }

  return (
    <>
      <div className="library-switcher">
        <Database size={15} />
        <select
          aria-label="Knowledge database"
          value={activeLibraryId}
          onChange={(event) => onChange(event.target.value)}
          disabled={isBusy}
        >
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          title="Rename database"
          aria-label="Rename database"
          onClick={() => {
            setName(activeLibrary.name);
            setDialogMode("rename");
          }}
          disabled={isBusy}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          title="Delete database"
          aria-label="Delete database"
          onClick={() => void handleDelete()}
          disabled={isBusy || isSaving || activeLibraryId === "default"}
        >
          <Trash2 size={13} />
        </button>
        <button
          type="button"
          title="New database"
          aria-label="New database"
          onClick={() => {
            setName("");
            setDialogMode("create");
          }}
          disabled={isBusy}
        >
          <Plus size={14} />
        </button>
      </div>

      {dialogMode && (
        <div
          className="dialog-backdrop"
          onMouseDown={isSaving ? undefined : () => setDialogMode(null)}
        >
          <section
            className="entity-dialog library-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>Knowledge database</span>
                <h2 id="library-dialog-title">
                  {dialogMode === "rename" ? "Rename database" : "New database"}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                title="Close"
                aria-label="Close"
                onClick={() => setDialogMode(null)}
                disabled={isSaving}
              >
                <X size={18} />
              </button>
            </header>
            <form className="entity-form" onSubmit={handleSubmit}>
              <label className="field field--wide">
                <span>Name</span>
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Competition game"
                />
              </label>
              <footer className="form-actions">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setDialogMode(null)}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button type="submit" className="primary-button" disabled={isSaving}>
                  {isSaving
                    ? "Saving..."
                    : dialogMode === "rename"
                      ? "Save name"
                      : "Create database"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </>
  );
}