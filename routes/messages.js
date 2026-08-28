/**
 * ProManage ERP - Contact Messages API
 * Handles contact form submissions and admin message management
 */

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, insert, update } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// Public - Submit contact message from landing page
router.post('/public', async (req, res) => {
  try {
    const { name, email, phone, company, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Name, email, subject, and message are required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const id = uuidv4();
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';

    await insert('contact_messages', {
      id,
      name,
      email,
      phone: phone || null,
      company: company || null,
      subject,
      message,
      status: 'unread',
      ip_address: ipAddress,
      user_agent: userAgent,
    });

    res.json({ 
      success: true, 
      message: 'Your message has been sent successfully. We will get back to you soon.',
      id 
    });
  } catch (err) {
    console.error('Submit contact message error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

// Admin - Get all messages with filtering
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;

    let sql = 'SELECT * FROM contact_messages WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ? OR subject LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const messages = await query(sql, params);

    // Get counts
    const counts = await query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unread' THEN 1 ELSE 0 END) as unread,
        SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) as read_count,
        SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
      FROM contact_messages
    `);

    res.json({
      messages,
      counts: counts[0] || { total: 0, unread: 0, read_count: 0, replied: 0, archived: 0 },
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Admin - Get single message
router.get('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const messages = await query('SELECT * FROM contact_messages WHERE id = ?', [id]);
    
    if (!messages.length) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Mark as read if unread
    if (messages[0].status === 'unread') {
      await update('contact_messages', { status: 'read' }, 'id = ?', [id]);
      messages[0].status = 'read';
    }

    res.json(messages[0]);
  } catch (err) {
    console.error('Get message error:', err);
    res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// Admin - Update message status
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reply_notes } = req.body;

    const updates = {};
    
    if (status) {
      updates.status = status;
      if (status === 'replied') {
        // Format date for MySQL (YYYY-MM-DD HH:MM:SS)
        const now = new Date();
        updates.replied_at = now.toISOString().slice(0, 19).replace('T', ' ');
        // Use null if user id not available
        updates.replied_by = req.user?.id || null;
      }
    }
    
    if (reply_notes !== undefined) {
      updates.reply_notes = reply_notes === undefined ? null : reply_notes;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await update('contact_messages', updates, 'id = ?', [id]);

    const messages = await query('SELECT * FROM contact_messages WHERE id = ?', [id]);
    
    res.json({ success: true, message: messages[0] });
  } catch (err) {
    console.error('Update message error:', err);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// Admin - Delete message
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await query('DELETE FROM contact_messages WHERE id = ?', [id]);

    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (err) {
    console.error('Delete message error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Admin - Bulk update status
router.post('/bulk-update', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { ids, status } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Message IDs are required' });
    }

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await query(
      `UPDATE contact_messages SET status = ?, updated_at = NOW() WHERE id IN (${placeholders})`,
      [status, ...ids]
    );

    res.json({ success: true, message: `${ids.length} messages updated` });
  } catch (err) {
    console.error('Bulk update error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
});

export default router;
