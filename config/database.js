import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'promanage_erp',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function insert(table, data) {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const [result] = await pool.execute(sql, values);
  return result;
}

export async function update(table, data, where, whereParams = []) {
  const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(data), ...whereParams];
  const sql = `UPDATE ${table} SET ${sets} WHERE ${where}`;
  const [result] = await pool.execute(sql, values);
  return result;
}

export async function remove(table, where, whereParams = []) {
  const sql = `DELETE FROM ${table} WHERE ${where}`;
  const [result] = await pool.execute(sql, whereParams);
  return result;
}

/**
 * Run work inside a MySQL transaction. Automatically rolls back on error.
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function connInsert(conn, table, data) {
  const keys = Object.keys(data);
  const values = Object.values(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const [result] = await conn.execute(sql, values);
  return result;
}

export async function connQuery(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}

export async function connQueryOne(conn, sql, params = []) {
  const rows = await connQuery(conn, sql, params);
  return rows[0] || null;
}

export default pool;
