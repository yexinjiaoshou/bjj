import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const initialMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0001_initial.sql"),
  "utf8",
);
const removePositionSideMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0002_remove_position_side.sql"),
  "utf8",
);
const mergePinIntoControlMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0003_merge_pin_into_control.sql"),
  "utf8",
);
const allowUnknownTechniqueTargetMigration = readFileSync(
  resolve(
    process.cwd(),
    "src-tauri/migrations/0004_allow_unknown_technique_target.sql",
  ),
  "utf8",
);
const syncJournalMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0005_sync_journal.sql"),
  "utf8",
);
const syncTransportStateMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0006_sync_transport_state.sql"),
  "utf8",
);
const syncConflictsMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0007_sync_conflicts.sql"),
  "utf8",
);
const snapshotStateMigration = readFileSync(
  resolve(process.cwd(), "src-tauri/migrations/0008_snapshot_state.sql"),
  "utf8",
);

describe("initial SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(initialMigration);
    database.exec(removePositionSideMigration);
    database.exec(mergePinIntoControlMigration);
    database.exec(allowUnknownTechniqueTargetMigration);
    database.exec(syncJournalMigration);
    database.exec(syncTransportStateMigration);
    database.exec(syncConflictsMigration);
    database.exec(snapshotStateMigration);
  });

  afterEach(() => database.close());

  function addPosition(id: string) {
    database
      .prepare(
        `INSERT INTO positions (id, name, category, role, x, y)
        VALUES (?, ?, 'guard', 'bottom', 0, 0)`,
      )
      .run(id, id);
  }

  function count(table: string) {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count;
  }

  it("creates the business tables and rejects self-loop techniques", () => {
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('positions', 'techniques', 'attachments')
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["attachments", "positions", "techniques"]);
    const positionColumns = database
      .prepare("PRAGMA table_info(positions)")
      .all()
      .map((row) => row.name);
    expect(positionColumns).not.toContain("side");

    addPosition("p1");
    expect(() =>
      database.exec(
        `INSERT INTO techniques (
          id, source_position_id, target_position_id, name, gi_mode, difficulty
        ) VALUES ('t1', 'p1', 'p1', 'Loop', 'both', 'foundation')`,
      ),
    ).toThrow();
  });

  it("accepts an unknown target and preserves it until the transition is resolved", () => {
    addPosition("p1");
    addPosition("p2");
    database.exec(`
      INSERT INTO techniques (
        id, source_position_id, target_position_id, name, gi_mode, difficulty
      ) VALUES ('t1', 'p1', NULL, 'Unresolved sweep', 'both', 'foundation');
      UPDATE techniques SET target_position_id = 'p2' WHERE id = 't1';
    `);

    expect(
      database
        .prepare("SELECT target_position_id FROM techniques WHERE id = 't1'")
        .get(),
    ).toEqual({ target_position_id: "p2" });
  });

  it("cascades position deletion through techniques and all attachments", () => {
    addPosition("p1");
    addPosition("p2");
    database.exec(`
      INSERT INTO techniques (
        id, source_position_id, target_position_id, name, gi_mode, difficulty
      ) VALUES ('t1', 'p1', 'p2', 'Sweep', 'both', 'foundation');
      INSERT INTO attachments (id, owner_type, owner_id, kind, title, value)
      VALUES
        ('a1', 'position', 'p1', 'note', 'Position note', 'Cue'),
        ('a2', 'technique', 't1', 'link', 'Technique link', 'https://example.com');
      DELETE FROM positions WHERE id = 'p1';
    `);

    expect(count("positions")).toBe(1);
    expect(count("techniques")).toBe(0);
    expect(count("attachments")).toBe(0);
  });

  it("rejects attachments whose owner does not exist", () => {
    expect(() =>
      database.exec(
        `INSERT INTO attachments (id, owner_type, owner_id, kind, title, value)
         VALUES ('a1', 'position', 'missing', 'note', 'Orphan', 'No owner')`,
      ),
    ).toThrow(/owner does not exist/);
  });

  it("preserves legacy graph data while removing the side column", () => {
    database.close();
    database = new DatabaseSync(":memory:");
    database.exec(initialMigration);
    database.exec(`
      INSERT INTO positions (id, name, category, role, side, x, y)
      VALUES
        ('p1', 'Closed Guard', 'guard', 'bottom', 'both', 0, 0),
        ('p2', 'Mount', 'control', 'top', 'left', 100, 0);
      INSERT INTO techniques (
        id, source_position_id, target_position_id, name, gi_mode, difficulty
      ) VALUES ('t1', 'p1', 'p2', 'Sweep', 'both', 'foundation');
      INSERT INTO attachments (id, owner_type, owner_id, kind, title, value)
      VALUES ('a1', 'position', 'p1', 'note', 'Cue', 'Keep posture');
    `);

    database.exec(removePositionSideMigration);
    database.exec(mergePinIntoControlMigration);
    database.exec(allowUnknownTechniqueTargetMigration);
    database.exec(syncJournalMigration);
    database.exec(syncTransportStateMigration);
    database.exec(syncConflictsMigration);
    database.exec(snapshotStateMigration);

    expect(count("positions")).toBe(2);
    expect(count("techniques")).toBe(1);
    expect(count("attachments")).toBe(1);
    expect(
      database
        .prepare("PRAGMA table_info(positions)")
        .all()
        .map((row) => row.name),
    ).not.toContain("side");
    expect(
      database
        .prepare("SELECT target_position_id FROM techniques WHERE id = 't1'")
        .get(),
    ).toEqual({ target_position_id: "p2" });
  });

  it("merges legacy pins into controls and rejects new pin values", () => {
    database.close();
    database = new DatabaseSync(":memory:");
    database.exec(initialMigration);
    database.exec(`
      INSERT INTO positions (id, name, category, role, side, x, y)
      VALUES ('p1', 'Side Control', 'pin', 'top', 'both', 0, 0);
    `);
    database.exec(removePositionSideMigration);
    database.exec(mergePinIntoControlMigration);

    expect(
      (database.prepare("SELECT category FROM positions WHERE id = 'p1'").get() as {
        category: string;
      }).category,
    ).toBe("control");
    expect(() =>
      database.exec(
        `INSERT INTO positions (id, name, category, role, x, y)
         VALUES ('p2', 'North South', 'pin', 'top', 0, 0)`,
      ),
    ).toThrow(/merged into control/);
  });
});