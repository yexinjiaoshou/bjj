#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const VAULT_ROOT = resolve(
  process.env.ROLLMAP_OBSIDIAN_VAULT ?? "/Users/ypf/Documents/note/bjj",
);
const APP_DATA_ROOT = resolve(
  process.env.ROLLMAP_APP_DATA_ROOT ??
    "/Users/ypf/Library/Application Support/com.rollmap.app",
);
const DATABASE_PATH = join(APP_DATA_ROOT, "rollmap.db");
const MEDIA_ROOT = join(APP_DATA_ROOT, "media");
const BACKUP_ROOT = join(APP_DATA_ROOT, "migration-backups");
const UUID_NAMESPACE = "a470d8f5-c83f-43f4-9280-8584dc75b76e";
const APPLY = process.argv.includes("--apply");
const MEDIA_EXTENSIONS = new Set([".mp4", ".png"]);

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function uuidV5(value) {
  const hash = createHash("sha1")
    .update(uuidBytes(UUID_NAMESPACE))
    .update(value)
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== ".obsidian") {
        files.push(...(await walk(path)));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function vaultRelative(path) {
  return relative(VAULT_ROOT, path).split("/").join("/");
}

function stem(path) {
  return basename(path, extname(path));
}

function extractWikiTargets(markdown) {
  return [...markdown.matchAll(/!?\[\[([^\]]+)\]\]/g)].map((match) =>
    match[1].split("|")[0].trim(),
  );
}

function extractTags(markdown) {
  return [...markdown.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(
    (match) => match[1],
  );
}

function cleanMarkdown(markdown) {
  return markdown
    .replace(/!?\[\[[^\]]+\]\]/g, "")
    .split("\n")
    .filter((line) => !/^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveWikiTarget(target, filesByBasename) {
  const normalizedTarget = target.split("\\").join("/");
  const directCandidates = [
    resolve(VAULT_ROOT, normalizedTarget),
    resolve(VAULT_ROOT, "resources", normalizedTarget),
  ];
  const direct = directCandidates.find((candidate) =>
    filesByBasename.get(basename(candidate))?.includes(candidate),
  );
  if (direct) {
    return direct;
  }
  const matches = filesByBasename.get(basename(normalizedTarget)) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Wiki target ${target} resolved to ${matches.length} files instead of one`,
    );
  }
  return matches[0];
}

function mediaKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") {
    return "image";
  }
  if (extension === ".mp4") {
    return "video";
  }
  throw new Error(`Unsupported imported media type: ${path}`);
}

async function sha256(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function buildPlan() {
  const allFiles = await walk(VAULT_ROOT);
  const filesByBasename = new Map();
  for (const path of allFiles) {
    const key = basename(path);
    filesByBasename.set(key, [...(filesByBasename.get(key) ?? []), path]);
  }

  const positionPaths = allFiles
    .filter((path) => /^position\/(guard|top)\/[^/]+\.md$/.test(vaultRelative(path)))
    .sort((left, right) => vaultRelative(left).localeCompare(vaultRelative(right)));
  const positionPathSet = new Set(positionPaths.map(vaultRelative));
  const basenameCounts = new Map();
  for (const path of positionPaths) {
    basenameCounts.set(stem(path), (basenameCounts.get(stem(path)) ?? 0) + 1);
  }

  const canvasPaths = allFiles
    .filter((path) => extname(path).toLowerCase() === ".canvas")
    .sort();
  const canvasCoordinates = new Map();
  const canvasBounds = new Map();
  const techniqueDefinitions = [];
  const canvasMiddleMedia = new Set();

  for (const canvasPath of canvasPaths) {
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    const canvasRelativePath = vaultRelative(canvasPath);
    const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
    canvasBounds.set(canvasRelativePath, {
      minX: Math.min(...canvas.nodes.map(({ x }) => x)),
      minY: Math.min(...canvas.nodes.map(({ y }) => y)),
      maxY: Math.max(...canvas.nodes.map(({ y, height }) => y + height)),
    });
    for (const node of canvas.nodes) {
      if (node.type === "file" && positionPathSet.has(node.file)) {
        canvasCoordinates.set(node.file, {
          canvasPath: canvasRelativePath,
          x: node.x,
          y: node.y,
        });
      }
    }
    for (const middle of canvas.nodes) {
      if (middle.type !== "file" || positionPathSet.has(middle.file)) {
        continue;
      }
      const incoming = canvas.edges
        .filter((edge) => edge.toNode === middle.id)
        .map((edge) => nodes.get(edge.fromNode))
        .filter((node) => node?.type === "file" && positionPathSet.has(node.file));
      const outgoing = canvas.edges
        .filter((edge) => edge.fromNode === middle.id)
        .map((edge) => nodes.get(edge.toNode))
        .filter((node) => node?.type === "file" && positionPathSet.has(node.file));
      if (incoming.length === 1 && outgoing.length === 1) {
        techniqueDefinitions.push({
          canvasPath: canvasRelativePath,
          middlePath: middle.file,
          middleNodeId: middle.id,
          sourcePath: incoming[0].file,
          targetPath: outgoing[0].file,
        });
        if (MEDIA_EXTENSIONS.has(extname(middle.file).toLowerCase())) {
          canvasMiddleMedia.add(middle.file);
        }
      }
    }
  }

  const database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
  const existingPositions = database.prepare("SELECT id, name, x FROM positions").all();
  const existingIds = new Set([
    ...existingPositions.map((row) => row.id),
    ...database.prepare("SELECT id FROM techniques").all().map((row) => row.id),
    ...database.prepare("SELECT id FROM attachments").all().map((row) => row.id),
  ]);
  database.close();

  const maxExistingX = Math.max(...existingPositions.map(({ x }) => x), 0);
  const canvasOffsets = new Map();
  let nextCanvasY = 200;
  for (const canvasPath of canvasPaths.map(vaultRelative)) {
    const bounds = canvasBounds.get(canvasPath);
    canvasOffsets.set(canvasPath, {
      x: maxExistingX + 600 - bounds.minX,
      y: nextCanvasY - bounds.minY,
    });
    nextCanvasY += bounds.maxY - bounds.minY + 800;
  }
  let unplacedIndex = 0;

  const positions = [];
  const positionByPath = new Map();
  for (const path of positionPaths) {
    const sourcePath = vaultRelative(path);
    const role = sourcePath.startsWith("position/top/") ? "top" : "bottom";
    const originalName = stem(path);
    const duplicate = (basenameCounts.get(originalName) ?? 0) > 1;
    const displayName = duplicate
      ? `${originalName}（${role === "top" ? "上位" : "下位"}）`
      : originalName;
    const sourceCoordinates = canvasCoordinates.get(sourcePath);
    const canvasOffset = sourceCoordinates
      ? canvasOffsets.get(sourceCoordinates.canvasPath)
      : null;
    const coordinates = sourceCoordinates
      ? {
          x: sourceCoordinates.x + canvasOffset.x,
          y: sourceCoordinates.y + canvasOffset.y,
        }
      : {
          x: maxExistingX + 600 + (unplacedIndex % 4) * 360,
          y: nextCanvasY + 400 + Math.floor(unplacedIndex / 4) * 280,
        };
    if (!sourceCoordinates) {
      unplacedIndex += 1;
    }
    const markdown = await readFile(path, "utf8");
    const position = {
      id: uuidV5(`position:${sourcePath}`),
      sourcePath,
      name: displayName,
      aliases: duplicate ? [originalName] : [],
      description: cleanMarkdown(markdown),
      category: role === "top" ? "control" : "guard",
      role,
      tags: ["obsidian", role],
      ...coordinates,
      markdown,
    };
    positions.push(position);
    positionByPath.set(sourcePath, position);
  }

  const attachments = [];
  const attachmentKeys = new Set();
  function addAttachment(ownerType, ownerId, sourcePath) {
    const sourceRelativePath = vaultRelative(sourcePath);
    const key = `${ownerType}:${ownerId}:${sourceRelativePath}`;
    if (attachmentKeys.has(key)) {
      return;
    }
    attachmentKeys.add(key);
    const id = uuidV5(`attachment:${key}`);
    const extension = extname(sourcePath).toLowerCase();
    attachments.push({
      id,
      ownerType,
      ownerId,
      kind: mediaKind(sourcePath),
      title: basename(sourcePath),
      sourcePath: sourceRelativePath,
      sourceAbsolutePath: sourcePath,
      value: `media/${id}${extension}`,
    });
  }

  for (const position of positions) {
    for (const target of extractWikiTargets(position.markdown)) {
      const targetPath = resolveWikiTarget(target, filesByBasename);
      if (MEDIA_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
        addAttachment("position", position.id, targetPath);
      }
    }
  }

  const techniques = [];
  for (const definition of techniqueDefinitions) {
    const middleAbsolutePath = resolve(VAULT_ROOT, definition.middlePath);
    const middleExtension = extname(middleAbsolutePath).toLowerCase();
    const source = positionByPath.get(definition.sourcePath);
    const target = positionByPath.get(definition.targetPath);
    if (!source || !target) {
      throw new Error(`Canvas technique has an unknown endpoint: ${definition.middlePath}`);
    }
    const id = uuidV5(
      `technique:${definition.canvasPath}:${definition.middleNodeId}:${definition.middlePath}`,
    );
    let description = "";
    let tags = ["obsidian", "canvas"];
    const relatedTechniques = [];
    if (middleExtension === ".md") {
      const markdown = await readFile(middleAbsolutePath, "utf8");
      description = cleanMarkdown(markdown);
      tags = [...new Set([...tags, ...extractTags(markdown)])];
      for (const wikiTarget of extractWikiTargets(markdown)) {
        const linkedPath = resolveWikiTarget(wikiTarget, filesByBasename);
        const linkedRelativePath = vaultRelative(linkedPath);
        if (MEDIA_EXTENSIONS.has(extname(linkedPath).toLowerCase())) {
          addAttachment("technique", id, linkedPath);
          if (canvasMiddleMedia.has(linkedRelativePath)) {
            relatedTechniques.push(stem(linkedPath));
          }
        }
      }
    } else if (MEDIA_EXTENSIONS.has(middleExtension)) {
      addAttachment("technique", id, middleAbsolutePath);
    }
    if (relatedTechniques.length > 0) {
      description = [
        description,
        `原 Obsidian 笔记另引用：${relatedTechniques.join("、")}（已按 Canvas 迁移为独立动作）`,
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const name = stem(middleAbsolutePath);
    techniques.push({
      id,
      sourcePath: definition.middlePath,
      canvasPath: definition.canvasPath,
      sourcePositionId: source.id,
      targetPositionId: target.id,
      sourcePositionName: source.name,
      targetPositionName: target.name,
      name,
      description,
      giMode: /拉索|蜘蛛/.test(name) ? "gi" : "both",
      difficulty: "intermediate",
      tags,
    });
  }

  const explicitlyUsedMedia = new Set(attachments.map(({ sourcePath }) => sourcePath));
  const allMedia = allFiles
    .filter((path) => MEDIA_EXTENSIONS.has(extname(path).toLowerCase()))
    .map(vaultRelative)
    .sort();
  const orphanedMedia = allMedia.filter((path) => !explicitlyUsedMedia.has(path));
  const plannedIds = [
    ...positions.map(({ id }) => id),
    ...techniques.map(({ id }) => id),
    ...attachments.map(({ id }) => id),
  ];
  const idCollisions = plannedIds.filter((id) => existingIds.has(id));
  const existingNames = new Set(existingPositions.map(({ name }) => name));
  const nameCollisions = positions
    .map(({ name }) => name)
    .filter((name) => existingNames.has(name));

  for (const attachment of attachments) {
    attachment.bytes = (await stat(attachment.sourceAbsolutePath)).size;
  }

  return {
    source: VAULT_ROOT,
    destination: DATABASE_PATH,
    positions: positions.map(({ markdown: _markdown, ...position }) => position),
    techniques,
    attachments: attachments.map(({ sourceAbsolutePath: _absolute, ...attachment }) =>
      attachment,
    ),
    orphanedMedia,
    idCollisions,
    nameCollisions,
  };
}

function printPlan(plan) {
  const mediaBytes = plan.attachments.reduce((total, item) => total + item.bytes, 0);
  console.log(APPLY ? "Obsidian BJJ migration APPLY" : "Obsidian BJJ migration DRY RUN");
  console.log(`Source: ${plan.source}`);
  console.log(`Database: ${plan.destination}`);
  console.log(
    `Planned: ${plan.positions.length} positions, ${plan.techniques.length} techniques, ` +
      `${plan.attachments.length} media attachments (${mediaBytes.toLocaleString()} bytes)`,
  );
  console.log(`Unlinked media retained in vault: ${plan.orphanedMedia.length}`);
  console.log("\nPositions:");
  for (const position of plan.positions) {
    console.log(
      `  ${position.sourcePath} -> ${position.name} [${position.category}/${position.role}] ` +
        `@ ${position.x},${position.y}`,
    );
  }
  console.log("\nTechniques:");
  for (const technique of plan.techniques) {
    console.log(
      `  ${technique.sourcePositionName} -> ${technique.name} -> ${technique.targetPositionName}`,
    );
  }
  console.log("\nMedia attachments:");
  for (const attachment of plan.attachments) {
    console.log(
      `  ${attachment.sourcePath} -> ${attachment.ownerType}:${attachment.ownerId} ` +
        `(${attachment.bytes.toLocaleString()} bytes)`,
    );
  }
  if (plan.idCollisions.length || plan.nameCollisions.length) {
    console.log("\nCOLLISIONS:");
    console.log(`  IDs: ${plan.idCollisions.join(", ") || "none"}`);
    console.log(`  Names: ${plan.nameCollisions.join(", ") || "none"}`);
  }
}

function rollbackSql(plan) {
  const quoted = (values) => values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  return [
    "PRAGMA foreign_keys = ON;",
    "BEGIN IMMEDIATE;",
    `DELETE FROM attachments WHERE id IN (${quoted(plan.attachments.map(({ id }) => id))});`,
    `DELETE FROM techniques WHERE id IN (${quoted(plan.techniques.map(({ id }) => id))});`,
    `DELETE FROM positions WHERE id IN (${quoted(plan.positions.map(({ id }) => id))});`,
    "COMMIT;",
    "",
  ].join("\n");
}

async function applyPlan(plan) {
  if (plan.idCollisions.length > 0 || plan.nameCollisions.length > 0) {
    throw new Error("Migration collisions detected; refusing to modify the database");
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const backupDirectory = join(BACKUP_ROOT, `obsidian-bjj-${timestamp}`);
  await mkdir(backupDirectory, { recursive: true });

  let database = new DatabaseSync(DATABASE_PATH);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  await copyFile(DATABASE_PATH, join(backupDirectory, "rollmap-before.db"));
  await writeFile(
    join(backupDirectory, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  await writeFile(join(backupDirectory, "rollback.sql"), rollbackSql(plan));

  await mkdir(MEDIA_ROOT, { recursive: true });
  const copiedMedia = [];
  try {
    for (const attachment of plan.attachments) {
      const sourcePath = resolve(VAULT_ROOT, attachment.sourcePath);
      const destinationPath = resolve(APP_DATA_ROOT, attachment.value);
      if (dirname(destinationPath) !== MEDIA_ROOT) {
        throw new Error(`Unsafe media destination: ${attachment.value}`);
      }
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      copiedMedia.push(destinationPath);
      const [sourceHash, destinationHash] = await Promise.all([
        sha256(sourcePath),
        sha256(destinationPath),
      ]);
      if (sourceHash !== destinationHash) {
        throw new Error(`Copied media hash mismatch: ${attachment.sourcePath}`);
      }
      attachment.sha256 = sourceHash;
    }

    database = new DatabaseSync(DATABASE_PATH);
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    try {
      const insertPosition = database.prepare(
        `INSERT INTO positions (
          id, name, aliases_json, description, category, role, tags_json, x, y
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertTechnique = database.prepare(
        `INSERT INTO techniques (
          id, source_position_id, target_position_id, name, description,
          gi_mode, difficulty, tags_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertAttachment = database.prepare(
        `INSERT INTO attachments (
          id, owner_type, owner_id, kind, title, value, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const position of plan.positions) {
        insertPosition.run(
          position.id,
          position.name,
          JSON.stringify(position.aliases),
          position.description,
          position.category,
          position.role,
          JSON.stringify(position.tags),
          position.x,
          position.y,
        );
      }
      for (const technique of plan.techniques) {
        insertTechnique.run(
          technique.id,
          technique.sourcePositionId,
          technique.targetPositionId,
          technique.name,
          technique.description,
          technique.giMode,
          technique.difficulty,
          JSON.stringify(technique.tags),
        );
      }
      const ownerOrder = new Map();
      for (const attachment of plan.attachments) {
        const ownerKey = `${attachment.ownerType}:${attachment.ownerId}`;
        const sortOrder = ownerOrder.get(ownerKey) ?? 0;
        ownerOrder.set(ownerKey, sortOrder + 1);
        insertAttachment.run(
          attachment.id,
          attachment.ownerType,
          attachment.ownerId,
          attachment.kind,
          attachment.title,
          attachment.value,
          sortOrder,
        );
      }
      const integrity = database.prepare("PRAGMA integrity_check").all();
      const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
        throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
      }
      if (foreignKeyFailures.length > 0) {
        throw new Error(
          `SQLite foreign key check failed: ${JSON.stringify(foreignKeyFailures)}`,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  } catch (error) {
    await Promise.all(copiedMedia.map((path) => rm(path, { force: true })));
    throw error;
  }

  await writeFile(
    join(backupDirectory, "applied.json"),
    `${JSON.stringify({ ...plan, appliedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`\nBackup and rollback files: ${backupDirectory}`);
}

const plan = await buildPlan();
printPlan(plan);
if (APPLY) {
  await applyPlan(plan);
  console.log("\nMigration completed successfully.");
} else {
  console.log("\nNo files or database rows were changed. Re-run with --apply after review.");
}