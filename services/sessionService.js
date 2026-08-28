import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne } from '../config/database.js';

export const SESSION_TTL_DAYS = 7;

/** Only the hash is stored, so a database leak cannot be replayed as a bearer token. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function newSessionId() {
  return uuidv4();
}

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  const raw = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]
    || req?.ip
    || req?.socket?.remoteAddress
    || null;
  return raw ? String(raw).slice(0, 64) : null;
}

function clientAgent(req) {
  const agent = req?.headers?.['user-agent'];
  return agent ? String(agent).slice(0, 255) : null;
}

export async function createSession({ id, userId, token, req }) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await query(
    `INSERT INTO session_tokens (id, user_id, token_hash, ip, user_agent, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       ip = VALUES(ip),
       user_agent = VALUES(user_agent),
       expires_at = VALUES(expires_at),
       last_seen_at = NOW()`,
    [id, userId, hashToken(token), clientIp(req), clientAgent(req), expiresAt],
  );
  return id;
}

export async function findActiveSession(token) {
  return queryOne(
    `SELECT * FROM session_tokens WHERE token_hash = ? AND expires_at > NOW()`,
    [hashToken(token)],
  );
}

/** Throttled so a busy client does not write on every request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export async function touchSession(session, req) {
  const lastSeen = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
  if (Date.now() - lastSeen < TOUCH_INTERVAL_MS) return;
  await query(
    'UPDATE session_tokens SET last_seen_at = NOW(), ip = ?, user_agent = ? WHERE id = ?',
    [clientIp(req), clientAgent(req), session.id],
  );
}

export async function deleteSessionByToken(token) {
  const result = await query('DELETE FROM session_tokens WHERE token_hash = ?', [hashToken(token)]);
  return Number(result?.affectedRows || 0);
}

export async function deleteUserSessions(userId) {
  const result = await query('DELETE FROM session_tokens WHERE user_id = ?', [userId]);
  return Number(result?.affectedRows || 0);
}

export async function deleteTenantSessions(tenantId) {
  const result = await query(
    `DELETE st FROM session_tokens st
     JOIN profiles p ON p.user_id = st.user_id
     WHERE p.tenant_id = ?`,
    [tenantId],
  );
  return Number(result?.affectedRows || 0);
}

export async function listTenantSessions(tenantId, limit = 25) {
  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  return query(
    `SELECT st.id, st.user_id, st.ip, st.user_agent, st.created_at, st.last_seen_at, st.expires_at,
            p.full_name, p.avatar, u.email
     FROM session_tokens st
     JOIN profiles p ON p.user_id = st.user_id
     JOIN users u ON u.id = st.user_id
     WHERE p.tenant_id = ? AND st.expires_at > NOW()
     ORDER BY COALESCE(st.last_seen_at, st.created_at) DESC
     LIMIT ${safeLimit}`,
    [tenantId],
  );
}

export async function countTenantSessions(tenantId) {
  const row = await queryOne(
    `SELECT COUNT(*) AS count
     FROM session_tokens st
     JOIN profiles p ON p.user_id = st.user_id
     WHERE p.tenant_id = ? AND st.expires_at > NOW()`,
    [tenantId],
  );
  return Number(row?.count || 0);
}

export async function pruneExpiredSessions() {
  const result = await query('DELETE FROM session_tokens WHERE expires_at <= NOW()');
  return Number(result?.affectedRows || 0);
}
