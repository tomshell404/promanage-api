import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ============================================
// SUPPORT AGENT AUTH ENDPOINTS
// ============================================

// Agent login
router.post('/agent/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const agents = await query(
      'SELECT * FROM support_agents WHERE email = ? AND active = 1',
      [email]
    );

    if (agents.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const agent = agents[0];
    const validPassword = await bcrypt.compare(password, agent.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last seen and set online
    await update('support_agents', { 
      last_seen: new Date(), 
      status: 'online' 
    }, 'id = ?', [agent.id]);

    // Log activity
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: agent.id,
      action: 'login',
      details: JSON.stringify({ ip: req.ip })
    });

    // Generate token
    const token = jwt.sign(
      { 
        id: agent.id, 
        email: agent.email, 
        role: 'support_agent',
        agentRole: agent.role 
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      token,
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        avatar: agent.avatar,
        role: agent.role,
        status: 'online',
        specialization: agent.specialization
      }
    });
  } catch (error) {
    console.error('[Support] Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Agent logout
router.post('/agent/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.json({ success: true });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    if (decoded.role === 'support_agent') {
      await update('support_agents', { status: 'offline' }, 'id = ?', [decoded.id]);
      
      await insert('agent_activity_log', {
        id: uuidv4(),
        agent_id: decoded.id,
        action: 'logout'
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.json({ success: true });
  }
});

// Middleware to authenticate support agent
const authenticateAgent = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log('[Support Auth] Header:', authHeader ? 'Present' : 'Missing');
    
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    console.log('[Support Auth] Token:', token ? token.substring(0, 20) + '...' : 'null');
    
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('[Support Auth] Decoded:', { id: decoded.id, role: decoded.role });
    
    if (decoded.role !== 'support_agent') {
      console.log('[Support Auth] Not a support agent role');
      return res.status(403).json({ error: 'Not a support agent' });
    }

    const agents = await query('SELECT * FROM support_agents WHERE id = ? AND active = 1', [decoded.id]);
    console.log('[Support Auth] Found agents:', agents.length);
    
    if (agents.length === 0) {
      return res.status(403).json({ error: 'Agent not found or inactive' });
    }

    req.agent = agents[0];
    next();
  } catch (error) {
    console.error('[Support Auth] Error:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================
// AGENT DASHBOARD ENDPOINTS
// ============================================

// Get agent profile
router.get('/agent/me', authenticateAgent, async (req, res) => {
  const agent = req.agent;
  res.json({
    id: agent.id,
    name: agent.name,
    email: agent.email,
    avatar: agent.avatar,
    role: agent.role,
    status: agent.status,
    specialization: agent.specialization,
    maxConcurrentChats: agent.max_concurrent_chats,
    currentChats: agent.current_chats,
    rating: parseFloat(agent.rating) || 0,
    ratingCount: parseInt(agent.rating_count) || 0
  });
});

// Update agent profile
router.patch('/agent/me', authenticateAgent, async (req, res) => {
  try {
    const { name } = req.body;
    const updates = {};
    
    if (name) updates.name = name;

    if (Object.keys(updates).length > 0) {
      await update('support_agents', updates, 'id = ?', [req.agent.id]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[Support] Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update agent avatar
router.patch('/agent/avatar', authenticateAgent, async (req, res) => {
  try {
    const { avatar } = req.body;
    
    if (!avatar) {
      return res.status(400).json({ error: 'Avatar is required' });
    }

    // Validate base64 image format
    if (!avatar.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image format' });
    }

    await update('support_agents', { avatar }, 'id = ?', [req.agent.id]);
    
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: 'avatar_update',
      details: JSON.stringify({ updated: true })
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[Support] Avatar update error:', error);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

// Change agent password
router.patch('/agent/password', authenticateAgent, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, req.agent.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash and update new password
    const newHash = await bcrypt.hash(newPassword, 10);
    await update('support_agents', { password_hash: newHash }, 'id = ?', [req.agent.id]);
    
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: 'password_change',
      details: JSON.stringify({ success: true })
    });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('[Support] Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Update agent status
router.patch('/agent/status', authenticateAgent, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['online', 'away', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // If going offline, release all active chats back to queue
    if (status === 'offline') {
      // Get all active conversations assigned to this agent
      const activeChats = await query(
        'SELECT id FROM chat_conversations WHERE assigned_agent_id = ? AND status = "active"',
        [req.agent.id]
      );
      
      if (activeChats.length > 0) {
        // Release chats back to queue
        await query(
          `UPDATE chat_conversations 
           SET assigned_agent_id = NULL, 
               status = 'pending_review', 
               is_bot_handled = 0,
               waiting_since = NOW()
           WHERE assigned_agent_id = ? AND status = "active"`,
          [req.agent.id]
        );
        
        // Log the release
        await insert('agent_activity_log', {
          id: uuidv4(),
          agent_id: req.agent.id,
          action: 'chats_released',
          details: JSON.stringify({ count: activeChats.length, reason: 'went_offline' })
        });
      }
      
      // Reset current_chats to 0
      await update('support_agents', { 
        status, 
        last_seen: new Date(),
        current_chats: 0
      }, 'id = ?', [req.agent.id]);
    } else {
      await update('support_agents', { 
        status, 
        last_seen: new Date() 
      }, 'id = ?', [req.agent.id]);
    }

    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: 'status_change',
      details: JSON.stringify({ newStatus: status })
    });

    res.json({ success: true, status });
  } catch (error) {
    console.error('[Support] Status update error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Get assigned conversations for agent
router.get('/agent/conversations', authenticateAgent, async (req, res) => {
  try {
    const { status } = req.query;
    
    let sql = `
      SELECT c.*, 
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
        (SELECT message FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_time
      FROM chat_conversations c
      WHERE c.assigned_agent_id = ?
    `;
    
    const params = [req.agent.id];
    
    if (status) {
      sql += ' AND c.status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY c.updated_at DESC LIMIT 50';

    const conversations = await query(sql, params);
    res.json(conversations);
  } catch (error) {
    console.error('[Support] Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get waiting queue (unassigned conversations needing human support)
router.get('/agent/queue', authenticateAgent, async (req, res) => {
  try {
    const conversations = await query(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
        (SELECT message FROM chat_messages WHERE conversation_id = c.id AND sender_type = 'user' ORDER BY created_at DESC LIMIT 1) as last_user_message
      FROM chat_conversations c
      WHERE c.assigned_agent_id IS NULL 
        AND c.status = 'pending_review'
        AND c.is_bot_handled = 0
      ORDER BY c.priority DESC, c.waiting_since ASC
      LIMIT 20
    `);
    res.json(conversations);
  } catch (error) {
    console.error('[Support] Get queue error:', error);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// Claim a conversation from queue
router.post('/agent/claim/:conversationId', authenticateAgent, async (req, res) => {
  try {
    const { conversationId } = req.params;

    // Check if already assigned
    const conv = await query('SELECT * FROM chat_conversations WHERE id = ?', [conversationId]);
    if (conv.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (conv[0].assigned_agent_id) {
      return res.status(400).json({ error: 'Already assigned to another agent' });
    }

    // Check agent's current chat count
    if (req.agent.current_chats >= req.agent.max_concurrent_chats) {
      return res.status(400).json({ error: 'You have reached your maximum concurrent chats' });
    }

    // Assign to agent
    await update('chat_conversations', {
      assigned_agent_id: req.agent.id,
      status: 'active',
      is_bot_handled: false
    }, 'id = ?', [conversationId]);

    // Update agent's chat count AND set status to online (if claiming, they must be available)
    await query('UPDATE support_agents SET current_chats = current_chats + 1, status = "online", last_seen = NOW() WHERE id = ?', [req.agent.id]);

    // Check if this was a transferred chat (had previous messages from another agent)
    const previousAgentMessages = await query(
      `SELECT DISTINCT a.name FROM chat_messages m 
       JOIN support_agents a ON m.agent_id = a.id 
       WHERE m.conversation_id = ? AND m.agent_id != ?`,
      [conversationId, req.agent.id]
    );
    const isTransfer = previousAgentMessages.length > 0;

    // Log activity
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: isTransfer ? 'chat_transferred' : 'chat_assigned',
      details: JSON.stringify({ conversationId, isTransfer })
    });

    // Send system message
    const systemMessage = isTransfer 
      ? `🔄 Your chat has been transferred to **${req.agent.name}**. I've reviewed your conversation and I'm here to help!`
      : `👋 You're now connected with **${req.agent.name}**. How can I help you today?`;
    
    await insert('chat_messages', {
      id: uuidv4(),
      conversation_id: conversationId,
      sender_type: 'bot',
      message: systemMessage,
      agent_id: req.agent.id
    });

    res.json({ success: true, isTransfer });
  } catch (error) {
    console.error('[Support] Claim conversation error:', error);
    res.status(500).json({ error: 'Failed to claim conversation' });
  }
});

// Send message as agent
router.post('/agent/message/:conversationId', authenticateAgent, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    // Verify agent is assigned
    const conv = await query('SELECT * FROM chat_conversations WHERE id = ? AND assigned_agent_id = ?', 
      [conversationId, req.agent.id]);
    if (conv.length === 0) {
      return res.status(403).json({ error: 'Not authorized for this conversation' });
    }

    const msgId = uuidv4();
    await insert('chat_messages', {
      id: msgId,
      conversation_id: conversationId,
      sender_type: 'admin',
      message: message.trim(),
      agent_id: req.agent.id,
      is_answered: true
    });

    // Update conversation
    await update('chat_conversations', { updated_at: new Date() }, 'id = ?', [conversationId]);

    // Log activity
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: 'message_sent',
      details: JSON.stringify({ conversationId, messageId: msgId })
    });

    res.json({ id: msgId, success: true });
  } catch (error) {
    console.error('[Support] Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Resolve conversation
router.post('/agent/resolve/:conversationId', authenticateAgent, async (req, res) => {
  try {
    const { conversationId } = req.params;

    // Verify agent is assigned
    const conv = await query('SELECT * FROM chat_conversations WHERE id = ? AND assigned_agent_id = ?', 
      [conversationId, req.agent.id]);
    if (conv.length === 0) {
      return res.status(403).json({ error: 'Not authorized for this conversation' });
    }

    await update('chat_conversations', { status: 'resolved' }, 'id = ?', [conversationId]);

    // Decrease agent's chat count
    await query('UPDATE support_agents SET current_chats = GREATEST(0, current_chats - 1) WHERE id = ?', [req.agent.id]);

    // Log activity
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: req.agent.id,
      action: 'chat_resolved',
      details: JSON.stringify({ conversationId })
    });

    // Send closing message
    await insert('chat_messages', {
      id: uuidv4(),
      conversation_id: conversationId,
      sender_type: 'bot',
      message: 'This conversation has been resolved. Thank you for contacting us! If you need further assistance, feel free to start a new chat.',
      agent_id: req.agent.id
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[Support] Resolve conversation error:', error);
    res.status(500).json({ error: 'Failed to resolve conversation' });
  }
});

// Get conversation messages
router.get('/agent/conversation/:conversationId', authenticateAgent, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conv = await query('SELECT * FROM chat_conversations WHERE id = ?', [conversationId]);
    if (conv.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await query(`
      SELECT m.*, a.name as agent_name
      FROM chat_messages m
      LEFT JOIN support_agents a ON m.agent_id = a.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `, [conversationId]);

    res.json({
      ...conv[0],
      messages
    });
  } catch (error) {
    console.error('[Support] Get conversation error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Get agent stats
router.get('/agent/stats', authenticateAgent, async (req, res) => {
  try {
    const agentId = req.agent.id;

    const [totalHandled] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ?',
      [agentId]
    );
    
    const [resolved] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ? AND status = "resolved"',
      [agentId]
    );
    
    const [activeChats] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ? AND status = "active"',
      [agentId]
    );
    
    const [messagesToday] = await query(
      `SELECT COUNT(*) as count FROM chat_messages 
       WHERE agent_id = ? AND DATE(created_at) = CURDATE()`,
      [agentId]
    );

    res.json({
      totalHandled: totalHandled.count,
      resolved: resolved.count,
      activeChats: activeChats.count,
      messagesToday: messagesToday.count
    });
  } catch (error) {
    console.error('[Support] Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get agent's own rating history
router.get('/agent/ratings', authenticateAgent, async (req, res) => {
  try {
    const agentId = req.agent.id;
    
    // Get all rating logs for this agent
    const ratings = await query(`
      SELECT id, details, created_at
      FROM agent_activity_log
      WHERE agent_id = ? AND action = 'rated'
      ORDER BY created_at DESC
      LIMIT 20
    `, [agentId]);
    
    // Parse the details JSON for each rating
    const parsedRatings = ratings.map(r => {
      let details = {};
      try {
        details = JSON.parse(r.details || '{}');
      } catch {}
      
      return {
        id: r.id,
        rating: details.rating || 0,
        comment: details.comment || '',
        newAverage: details.newAverage || 0,
        createdAt: r.created_at
      };
    });
    
    res.json(parsedRatings);
  } catch (error) {
    console.error('[Support] Get agent ratings error:', error);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// ============================================
// ADMIN ENDPOINTS (Super Admin manages agents)
// ============================================

// Get all agents
router.get('/agents', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const agents = await query(`
      SELECT id, email, name, avatar, role, status, max_concurrent_chats, 
             current_chats, specialization, active, last_seen, created_at,
             rating, rating_count
      FROM support_agents
      ORDER BY created_at DESC
    `);
    res.json(agents);
  } catch (error) {
    console.error('[Support] Get agents error:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Create agent
router.post('/agents', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, name, role, specialization, maxConcurrentChats } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Check if email exists
    const existing = await query('SELECT id FROM support_agents WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await insert('support_agents', {
      id,
      email,
      password_hash: passwordHash,
      name,
      role: role || 'agent',
      specialization: specialization || 'general',
      max_concurrent_chats: maxConcurrentChats || 5,
      active: true,
      status: 'offline'
    });

    const agent = await query('SELECT * FROM support_agents WHERE id = ?', [id]);
    res.status(201).json({
      id: agent[0].id,
      email: agent[0].email,
      name: agent[0].name,
      role: agent[0].role,
      specialization: agent[0].specialization
    });
  } catch (error) {
    console.error('[Support] Create agent error:', error);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// Update agent
router.patch('/agents/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, specialization, maxConcurrentChats, active } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (email !== undefined) updates.email = email;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);
    if (role !== undefined) updates.role = role;
    if (specialization !== undefined) updates.specialization = specialization;
    if (maxConcurrentChats !== undefined) updates.max_concurrent_chats = maxConcurrentChats;
    if (active !== undefined) updates.active = active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await update('support_agents', updates, 'id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Support] Update agent error:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// Delete agent
router.delete('/agents/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await remove('support_agents', 'id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Support] Delete agent error:', error);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// Get online agents (for routing)
router.get('/agents/online', async (req, res) => {
  try {
    const { specialization } = req.query;
    
    let sql = `
      SELECT id, name, specialization, current_chats, max_concurrent_chats
      FROM support_agents
      WHERE active = 1 AND status = 'online' AND current_chats < max_concurrent_chats
    `;
    
    const params = [];
    if (specialization && specialization !== 'general') {
      sql += ' AND (specialization = ? OR specialization = "general")';
      params.push(specialization);
    }
    
    sql += ' ORDER BY current_chats ASC, RAND() LIMIT 1';

    const agents = await query(sql, params);
    res.json({ 
      available: agents.length > 0,
      agent: agents[0] || null
    });
  } catch (error) {
    console.error('[Support] Get online agents error:', error);
    res.status(500).json({ error: 'Failed to check online agents' });
  }
});

// Get agent details with full stats (Super Admin)
router.get('/agents/:id/details', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get agent info
    const agents = await query(
      'SELECT * FROM support_agents WHERE id = ?',
      [id]
    );
    
    if (agents.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const agent = agents[0];
    
    // Get stats
    const [totalChats] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ?',
      [id]
    );
    
    const [resolvedChats] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ? AND status = "resolved"',
      [id]
    );
    
    const [activeChats] = await query(
      'SELECT COUNT(*) as count FROM chat_conversations WHERE assigned_agent_id = ? AND status = "active"',
      [id]
    );
    
    const [totalMessages] = await query(
      'SELECT COUNT(*) as count FROM chat_messages WHERE agent_id = ?',
      [id]
    );
    
    const [messagesThisWeek] = await query(
      `SELECT COUNT(*) as count FROM chat_messages 
       WHERE agent_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [id]
    );
    
    const [messagesThisMonth] = await query(
      `SELECT COUNT(*) as count FROM chat_messages 
       WHERE agent_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      [id]
    );
    
    // Get average response time (time between user message and agent response)
    const [avgResponseTime] = await query(
      `SELECT AVG(response_time) as avg_time FROM (
        SELECT TIMESTAMPDIFF(SECOND, 
          (SELECT created_at FROM chat_messages m2 
           WHERE m2.conversation_id = m1.conversation_id 
           AND m2.sender_type = 'user' AND m2.created_at < m1.created_at 
           ORDER BY created_at DESC LIMIT 1),
          m1.created_at
        ) as response_time
        FROM chat_messages m1
        WHERE m1.agent_id = ? AND m1.sender_type = 'admin'
      ) as response_times WHERE response_time IS NOT NULL AND response_time < 3600`,
      [id]
    );
    
    // Get recent activity log
    const activityLog = await query(
      `SELECT * FROM agent_activity_log 
       WHERE agent_id = ? 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [id]
    );
    
    // Get recent resolved conversations
    const recentResolved = await query(
      `SELECT c.*, 
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id AND agent_id = ?) as agent_messages
       FROM chat_conversations c
       WHERE c.assigned_agent_id = ? AND c.status = 'resolved'
       ORDER BY c.updated_at DESC
       LIMIT 10`,
      [id, id]
    );
    
    res.json({
      agent: {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        avatar: agent.avatar,
        role: agent.role,
        status: agent.status,
        specialization: agent.specialization,
        active: agent.active,
        rating: agent.rating || 0,
        rating_count: agent.rating_count || 0,
        max_concurrent_chats: agent.max_concurrent_chats,
        current_chats: agent.current_chats,
        last_seen: agent.last_seen,
        created_at: agent.created_at
      },
      stats: {
        totalChats: totalChats.count,
        resolvedChats: resolvedChats.count,
        activeChats: activeChats.count,
        totalMessages: totalMessages.count,
        messagesThisWeek: messagesThisWeek.count,
        messagesThisMonth: messagesThisMonth.count,
        avgResponseTime: Math.round(avgResponseTime.avg_time || 0),
        resolutionRate: totalChats.count > 0 
          ? Math.round((resolvedChats.count / totalChats.count) * 100) 
          : 0
      },
      activityLog,
      recentResolved
    });
  } catch (error) {
    console.error('[Support] Get agent details error:', error);
    res.status(500).json({ error: 'Failed to fetch agent details' });
  }
});

// Rate agent (Super Admin)
router.post('/agents/:id/rate', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }
    
    // Get current rating
    const agents = await query('SELECT rating, rating_count FROM support_agents WHERE id = ?', [id]);
    if (agents.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const currentRating = agents[0].rating || 0;
    const currentCount = agents[0].rating_count || 0;
    
    // Calculate new average rating
    const newCount = currentCount + 1;
    const newRating = ((currentRating * currentCount) + rating) / newCount;
    
    // Update agent rating
    await update('support_agents', {
      rating: Math.round(newRating * 10) / 10, // Round to 1 decimal
      rating_count: newCount
    }, 'id = ?', [id]);
    
    // Log the rating
    await insert('agent_activity_log', {
      id: uuidv4(),
      agent_id: id,
      action: 'rated',
      details: JSON.stringify({ rating, comment, newAverage: newRating })
    });
    
    res.json({ 
      success: true, 
      newRating: Math.round(newRating * 10) / 10,
      ratingCount: newCount
    });
  } catch (error) {
    console.error('[Support] Rate agent error:', error);
    res.status(500).json({ error: 'Failed to rate agent' });
  }
});

export default router;
