import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const graphMigrations = [
  "0001_initial.sql",
  "0002_remove_position_side.sql",
  "0003_merge_pin_into_control.sql",
  "0004_allow_unknown_technique_target.sql",
  "0005_sync_journal.sql",
  "0006_sync_transport_state.sql",
  "0007_sync_conflicts.sql",
  "0008_snapshot_state.sql",
].map((filename) =>
  readFileSync(resolve(process.cwd(), "src-tauri/migrations", filename), "utf8"),
);

describe("unified knowledge database schema", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    graphMigrations.forEach((migration) => database.exec(migration));
  });

  afterEach(() => database.close());

  it("starts empty and accepts only the merged position categories", () => {
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM positions").get(),
    ).toEqual({ count: 0 });
    expect(() =>
      database.exec(
        `INSERT INTO positions (id, name, category, role, x, y)
         VALUES ('p1', 'Side Control', 'pin', 'top', 0, 0)`,
      ),
    ).toThrow();
    expect(() =>
      database.exec(
        `INSERT INTO positions (id, name, category, role, x, y)
         VALUES ('p1', 'Side Control', 'control', 'top', 0, 0)`,
      ),
    ).not.toThrow();
  });

  it("preserves attachment ownership and graph cascade rules", () => {
    database.exec(`
      INSERT INTO positions (id, name, category, role, x, y)
      VALUES
        ('p1', 'Guard', 'guard', 'bottom', 0, 0),
        ('p2', 'Mount', 'control', 'top', 100, 0);
      INSERT INTO techniques (
        id, source_position_id, target_position_id, name, gi_mode, difficulty
      ) VALUES ('t1', 'p1', 'p2', 'Sweep', 'both', 'foundation');
      INSERT INTO attachments (id, owner_type, owner_id, kind, title, value)
      VALUES ('a1', 'technique', 't1', 'note', 'Cue', 'Turn the corner');
      DELETE FROM positions WHERE id = 'p1';
    `);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM techniques").get(),
    ).toEqual({ count: 0 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM attachments").get(),
    ).toEqual({ count: 0 });
  });

  it("stores an unresolved transition without creating a position", () => {
    database.exec(`
      INSERT INTO positions (id, name, category, role, x, y)
      VALUES ('p1', 'Guard', 'guard', 'bottom', 0, 0);
      INSERT INTO techniques (
        id, source_position_id, target_position_id, name, gi_mode, difficulty
      ) VALUES ('t1', 'p1', NULL, 'Unknown follow-up', 'both', 'foundation');
    `);

    expect(
      database
        .prepare("SELECT target_position_id FROM techniques WHERE id = 't1'")
        .get(),
    ).toEqual({ target_position_id: null });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM positions").get(),
    ).toEqual({ count: 1 });
  });

  it("stores sync winners and peer cursors separately from graph records", () => {
    expect(
      database
        .prepare("PRAGMA table_info(sync_entity_versions)")
        .all()
        .map((column) => column.name),
    ).toContain("payload_json");
    expect(
      database
        .prepare("PRAGMA table_info(sync_entity_versions)")
        .all()
        .map((column) => column.name),
    ).toContain("winning_change_id");
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'sync_peer_cursors'`,
        )
        .get(),
    ).toEqual({ name: "sync_peer_cursors" });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name = 'sync_conflicts'`,
        )
        .get(),
    ).toEqual({ name: "sync_conflicts" });
  });
});