/**
 * Logical MySQL backup: schema + data dump compatible with XAMPP restore.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { logAudit } from '../utils/auditLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const BACKUPS_DIR = path.join(__dirname, '..', 'backups');

async function ensureBackupsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS database_backups (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      error TEXT NULL,
      created_by VARCHAR(36) NULL,
      created_by_name VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function ensureDir() {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL';
    const pad = (n) => String(n).padStart(2, '0');
    const s = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return `'${s}'`;
  }
  if (Buffer.isBuffer(value)) {
    return `X'${value.toString('hex')}'`;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function dumpTable(stream, tableName) {
  const createRow = await queryOne(`SHOW CREATE TABLE \`${tableName}\``);
  const createSql = createRow?.['Create Table'] || createRow?.['Create View'];
  if (!createSql) return 0;

  stream.write(`\n-- ------------------------------------------------------------\n`);
  stream.write(`-- Table structure for \`${tableName}\`\n`);
  stream.write(`-- ------------------------------------------------------------\n`);
  stream.write(`DROP TABLE IF EXISTS \`${tableName}\`;\n`);
  stream.write(`${createSql};\n\n`);

  const rows = await query(`SELECT * FROM \`${tableName}\``);
  if (!rows.length) return 0;

  stream.write(`-- Data for \`${tableName}\`\n`);
  const cols = Object.keys(rows[0]);
  const colList = cols.map((c) => `\`${c}\``).join(', ');
  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = chunk
      .map((row) => `(${cols.map((c) => sqlLiteral(row[c])).join(', ')})`)
      .join(',\n');
    stream.write(`INSERT INTO \`${tableName}\` (${colList}) VALUES\n${values};\n`);
  }
  stream.write('\n');
  return rows.length;
}

async function dumpRoutines(stream) {
  const db = await queryOne('SELECT DATABASE() AS name');
  const schema = db?.name;
  if (!schema) return;

  try {
    const procs = await query(
      `SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.routines WHERE ROUTINE_SCHEMA = ?`,
      [schema],
    );
    for (const p of procs) {
      const show = p.ROUTINE_TYPE === 'PROCEDURE'
        ? await queryOne(`SHOW CREATE PROCEDURE \`${p.ROUTINE_NAME}\``)
        : await queryOne(`SHOW CREATE FUNCTION \`${p.ROUTINE_NAME}\``);
      const body = show?.['Create Procedure'] || show?.['Create Function'];
      if (body) {
        stream.write(`\nDELIMITER ;;\n${body};;\nDELIMITER ;\n`);
      }
    }
  } catch {
    // routines may be unavailable depending on grants
  }

  try {
    const triggers = await query('SHOW TRIGGERS');
    for (const t of triggers) {
      const create = await queryOne(`SHOW CREATE TRIGGER \`${t.Trigger}\``);
      const body = create?.['SQL Original Statement'];
      if (body) stream.write(`\nDELIMITER ;;\n${body};;\nDELIMITER ;\n`);
    }
  } catch {
    // ignore
  }

  try {
    const views = await query(
      `SELECT TABLE_NAME FROM information_schema.views WHERE TABLE_SCHEMA = ?`,
      [schema],
    );
    for (const v of views) {
      const create = await queryOne(`SHOW CREATE VIEW \`${v.TABLE_NAME}\``);
      const body = create?.['Create View'];
      if (body) {
        stream.write(`\nDROP VIEW IF EXISTS \`${v.TABLE_NAME}\`;\n${body};\n`);
      }
    }
  } catch {
    // ignore
  }
}

export async function getBackupStatus() {
  await ensureBackupsTable();
  ensureDir();
  const db = await queryOne('SELECT DATABASE() AS name');
  const size = await queryOne(`
    SELECT
      COUNT(*) AS tables_c,
      COALESCE(SUM(data_length + index_length), 0) AS size_bytes,
      COALESCE(SUM(table_rows), 0) AS row_estimate
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
  `);
  const last = await queryOne(
    `SELECT * FROM database_backups WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`,
  );
  const inProgress = await queryOne(
    `SELECT * FROM database_backups WHERE status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`,
  );

  return {
    databaseName: db?.name || null,
    databaseSizeBytes: Number(size?.size_bytes || 0),
    tableCount: Number(size?.tables_c || 0),
    estimatedRecords: Number(size?.row_estimate || 0),
    lastBackup: last || null,
    inProgress: inProgress || null,
    backupsDir: BACKUPS_DIR,
  };
}

export async function listBackups({ q, page = 1, pageSize = 20 } = {}) {
  await ensureBackupsTable();
  const limit = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (q) {
    where += ' AND (filename LIKE ? OR created_by_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const [items, total] = await Promise.all([
    query(
      `SELECT * FROM database_backups ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS c FROM database_backups ${where}`, params),
  ]);
  return { items, total: Number(total?.c || 0), page: Math.max(Number(page) || 1, 1), pageSize: limit };
}

export async function createBackup(req) {
  await ensureBackupsTable();
  ensureDir();

  const id = uuidv4();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `promanage-backup-${stamp}.sql`;
  const filePath = path.join(BACKUPS_DIR, filename);

  await insert('database_backups', {
    id,
    filename,
    size_bytes: 0,
    status: 'running',
    created_by: req.user?.id || null,
    created_by_name: req.user?.fullName || req.user?.email || 'Super Admin',
  });

  await logAudit({
    req,
    category: 'system',
    action: 'backup_create',
    description: `Started database backup ${filename}`,
    metadata: { backupId: id, filename },
  });

  try {
    const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    const db = await queryOne('SELECT DATABASE() AS name');
    stream.write(`-- ProManage ERP logical backup\n`);
    stream.write(`-- Generated: ${new Date().toISOString()}\n`);
    stream.write(`-- Database: ${db?.name || 'unknown'}\n`);
    stream.write(`SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n`);

    const tables = await query(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    let totalRows = 0;
    for (const t of tables) {
      const name = t.name || t.NAME || t.table_name;
      totalRows += await dumpTable(stream, name);
    }

    await dumpRoutines(stream);
    stream.write(`\nSET FOREIGN_KEY_CHECKS=1;\n`);

    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.end();
    });

    const stat = fs.statSync(filePath);
    await update(
      'database_backups',
      { status: 'completed', size_bytes: stat.size, error: null },
      'id = ?',
      [id],
    );

    await logAudit({
      req,
      category: 'system',
      action: 'backup_complete',
      description: `Completed database backup ${filename} (${stat.size} bytes, ~${totalRows} rows)`,
      metadata: { backupId: id, filename, sizeBytes: stat.size, totalRows },
    });

    return await queryOne('SELECT * FROM database_backups WHERE id = ?', [id]);
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
    await update(
      'database_backups',
      { status: 'failed', error: err.message || String(err) },
      'id = ?',
      [id],
    );
    await logAudit({
      req,
      category: 'system',
      action: 'backup_failed',
      description: `Database backup failed: ${err.message}`,
      metadata: { backupId: id, filename },
    });
    throw err;
  }
}

export async function getBackupFile(id) {
  await ensureBackupsTable();
  const row = await queryOne('SELECT * FROM database_backups WHERE id = ?', [id]);
  if (!row) return null;
  const filePath = path.join(BACKUPS_DIR, row.filename);
  if (!fs.existsSync(filePath)) return { row, missing: true };
  return { row, filePath, missing: false };
}

export async function deleteBackup(id, req) {
  await ensureBackupsTable();
  const row = await queryOne('SELECT * FROM database_backups WHERE id = ?', [id]);
  if (!row) {
    const err = new Error('Backup not found');
    err.status = 404;
    throw err;
  }
  const filePath = path.join(BACKUPS_DIR, row.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await remove('database_backups', 'id = ?', [id]);
  await logAudit({
    req,
    category: 'system',
    action: 'backup_delete',
    description: `Deleted database backup ${row.filename}`,
    metadata: { backupId: id, filename: row.filename },
  });
  return { success: true };
}
