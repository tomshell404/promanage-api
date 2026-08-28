import express from 'express';
import { query, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// ============================================
// PUBLIC ENDPOINTS (for landing page chat)
// ============================================

// Search knowledge base and get answer
router.post('/ask', async (req, res) => {
  try {
    const { sessionId, topic, message, visitorName, visitorEmail } = req.body;
    
    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Session ID and message are required' });
    }

    // Get or create conversation
    let conversation = await query(
      'SELECT c.*, a.status as agent_status, a.name as agent_name FROM chat_conversations c LEFT JOIN support_agents a ON c.assigned_agent_id = a.id WHERE c.session_id = ? AND c.status IN ("active", "pending_review") ORDER BY c.created_at DESC LIMIT 1',
      [sessionId]
    );

    let conversationId;
    let hasActiveHumanAgent = false;
    
    if (conversation.length === 0) {
      conversationId = uuidv4();
      await insert('chat_conversations', {
        id: conversationId,
        session_id: sessionId,
        visitor_name: visitorName || null,
        visitor_email: visitorEmail || null,
        topic: topic || 'general',
        status: 'active'
      });
    } else {
      conversationId = conversation[0].id;
      // Update topic if provided
      if (topic) {
        await update('chat_conversations', { topic }, 'id = ?', [conversationId]);
      }
      
      // Check if there's an active human agent assigned
      if (conversation[0].assigned_agent_id && conversation[0].agent_status === 'online') {
        hasActiveHumanAgent = true;
        console.log(`[Chat] Conversation has active human agent: ${conversation[0].agent_name}`);
      } else if (conversation[0].assigned_agent_id && conversation[0].agent_status !== 'online') {
        // Agent went offline - reset assignment
        console.log(`[Chat] Assigned agent went offline, resetting assignment`);
        await update('chat_conversations', { 
          assigned_agent_id: null,
          is_bot_handled: true 
        }, 'id = ?', [conversationId]);
        // Decrement the old agent's chat count
        await query('UPDATE support_agents SET current_chats = GREATEST(current_chats - 1, 0) WHERE id = ?', [conversation[0].assigned_agent_id]);
      }
    }

    // Save user message
    const userMessageId = uuidv4();
    await insert('chat_messages', {
      id: userMessageId,
      conversation_id: conversationId,
      sender_type: 'user',
      message: message,
      is_answered: !hasActiveHumanAgent // Mark as not answered if going to bot, answered if human will handle
    });

    // If there's an active human agent, don't send bot response - just notify about new message
    if (hasActiveHumanAgent) {
      console.log(`[Chat] Human agent active - skipping bot response`);
      return res.json({
        conversationId,
        answer: null, // No bot response
        isFromKnowledgeBase: false,
        knowledgeId: null,
        routedToAgent: true,
        hasHumanAgent: true,
        agentName: conversation[0].agent_name
      });
    }

    // Check if user wants to talk to human agent
    const lowerMessage = message.toLowerCase();
    const humanRequestPhrases = [
      'human', 'agent', 'real person', 'talk to', 'speak to', 'connect me', 'connect to',
      'representative', 'support team', 'live chat', 'live support', 'customer service',
      'not helpful', 'doesn\'t help', 'not answering', 'wrong answer', 'operator',
      'someone', 'staff member', 'real human', 'actual person', 'sales team'
    ];
    const wantsHuman = humanRequestPhrases.some(phrase => lowerMessage.includes(phrase));
    
    console.log(`[Chat] Human request check - Message: "${lowerMessage}", Wants human: ${wantsHuman}`);

    // Search knowledge base for answer
    const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will', 'more', 'when', 'who', 'how', 'what', 'why', 'where', 'which', 'this', 'that', 'with', 'from', 'they', 'would', 'there', 'their', 'about', 'into', 'your', 'just', 'could', 'than', 'like', 'other', 'some', 'them', 'these', 'then', 'now', 'only', 'also', 'does', 'very', 'much', 'any', 'lot', 'use', 'get', 'make'];
    
    const searchTerms = message.toLowerCase()
      .replace(/[?!.,;:'"]/g, '') // Remove punctuation
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.includes(w));
    
    // Key phrases to detect specific intents
    const pricingPhrases = ['price', 'pricing', 'cost', 'plan', 'plans', 'subscription', 'birr', 'etb', 'fee', 'payment', 'money', 'pay'];
    const securityPhrases = ['secure', 'security', 'safe', 'safety', 'encrypt', 'protection', 'data', 'privacy', 'backup'];
    const branchPhrases = ['branch', 'branches', 'location', 'locations', 'multiple', 'multi', 'chain', 'franchise', 'expand'];
    const featurePhrases = ['pos', 'order', 'inventory', 'stock', 'staff', 'report', 'kitchen', 'menu', 'analytics', 'recipe', 'billing', 'invoice'];
    const generalPhrases = ['promanage', 'erp', 'system', 'work', 'start', 'started', 'demo', 'trial', 'device', 'mobile', 'support', 'help', 'contact', 'training', 'guide'];
    
    // Check for specific topic matches
    const hasPricingIntent = searchTerms.some(t => pricingPhrases.includes(t) || pricingPhrases.some(p => t.includes(p)));
    const hasSecurityIntent = searchTerms.some(t => securityPhrases.includes(t) || securityPhrases.some(p => t.includes(p)));
    const hasBranchIntent = searchTerms.some(t => branchPhrases.includes(t) || branchPhrases.some(p => t.includes(p)));
    const hasFeatureIntent = searchTerms.some(t => featurePhrases.includes(t) || featurePhrases.some(p => t.includes(p)));
    const hasGeneralIntent = searchTerms.some(t => generalPhrases.includes(t) || generalPhrases.some(p => t.includes(p)));
    const hasSpecificIntent = hasPricingIntent || hasSecurityIntent || hasBranchIntent || hasFeatureIntent || hasGeneralIntent;
    
    let knowledgeResults = [];
    let matchQuality = 0;
    
    if (searchTerms.length > 0 && !wantsHuman && hasSpecificIntent) {
      // Build search query - prioritize keyword matches
      const keywordConditions = searchTerms.map(() => 'LOWER(keywords) LIKE ?').join(' OR ');
      const questionConditions = searchTerms.map(() => 'LOWER(question) LIKE ?').join(' OR ');
      
      const keywordParams = searchTerms.map(term => `%${term}%`);
      const questionParams = searchTerms.map(term => `%${term}%`);
      
      // Add category filter if topic specified
      const categoryFilter = topic && topic !== 'general' ? ' AND (category = ? OR category = "general")' : '';
      const categoryParams = topic && topic !== 'general' ? [topic] : [];

      // First try to find keyword matches (high quality)
      knowledgeResults = await query(
        `SELECT * FROM chat_knowledge_base 
         WHERE active = 1 AND (${keywordConditions})${categoryFilter}
         ORDER BY priority DESC
         LIMIT 1`,
        [...keywordParams, ...categoryParams]
      );
      
      if (knowledgeResults.length > 0) {
        matchQuality = 2; // High quality - keyword match
      } else {
        // Try question match (medium quality) - only if we have specific intent
        knowledgeResults = await query(
          `SELECT * FROM chat_knowledge_base 
           WHERE active = 1 AND (${questionConditions})${categoryFilter}
           ORDER BY priority DESC
           LIMIT 1`,
          [...questionParams, ...categoryParams]
        );
        if (knowledgeResults.length > 0) {
          matchQuality = 1; // Medium quality - question match
        }
      }
    }

    let botResponse;
    let knowledgeId = null;
    let isAnswered = false;
    let routedToAgent = false;

    // Route to human if user explicitly asked, or if no good match found
    const shouldRouteToHuman = wantsHuman || matchQuality === 0 || !hasSpecificIntent;
    
    console.log(`[Chat] Query: "${message}"`);
    console.log(`[Chat] Search terms: ${searchTerms.join(', ')}`);
    console.log(`[Chat] Intent detected - Pricing: ${hasPricingIntent}, Security: ${hasSecurityIntent}, Branch: ${hasBranchIntent}, Feature: ${hasFeatureIntent}, General: ${hasGeneralIntent}`);
    console.log(`[Chat] Has specific intent: ${hasSpecificIntent}, Wants human: ${wantsHuman}, Match quality: ${matchQuality}`);
    console.log(`[Chat] Should route to human: ${shouldRouteToHuman}`);

    if (knowledgeResults.length > 0 && !shouldRouteToHuman) {
      // Found good answer in knowledge base
      console.log(`[Chat] Matched KB entry: ${knowledgeResults[0].question}`);
      botResponse = knowledgeResults[0].answer;
      knowledgeId = knowledgeResults[0].id;
      isAnswered = true;
    } else {
      // No good answer found or user wants human - check for online human agents
      console.log(`[Chat] Routing to human support...`);
      const onlineAgents = await query(`
        SELECT id, name, avatar, specialization, current_chats, max_concurrent_chats
        FROM support_agents
        WHERE active = 1 AND status = 'online' AND current_chats < max_concurrent_chats
        ${topic && topic !== 'general' ? 'AND (specialization = ? OR specialization = "general")' : ''}
        ORDER BY current_chats ASC
        LIMIT 1
      `, topic && topic !== 'general' ? [topic] : []);

      if (onlineAgents.length > 0) {
        // Assign to online agent
        const agent = onlineAgents[0];
        await update('chat_conversations', { 
          status: 'active',
          assigned_agent_id: agent.id,
          is_bot_handled: false,
          waiting_since: null
        }, 'id = ?', [conversationId]);

        // Update agent's chat count
        await query('UPDATE support_agents SET current_chats = current_chats + 1 WHERE id = ?', [agent.id]);

        console.log(`[Chat] Routing to agent: ${agent.name} (ID: ${agent.id})`);
        
        botResponse = `🎧 **Connecting you with a support agent...**\n\nPlease wait a moment while I connect you with **${agent.name}** from our support team.\n\n💬 They will respond to your message shortly. Feel free to provide more details about your inquiry while you wait.`;
        routedToAgent = true;
      } else {
        // No online agents - put in queue with polite message
        await update('chat_conversations', { 
          status: 'pending_review',
          is_bot_handled: false,
          waiting_since: new Date()
        }, 'id = ?', [conversationId]);
        
        botResponse = "I appreciate your question! This requires assistance from our support team.\n\n⏳ **Current Status:** All our support agents are currently helping other customers.\n\n📝 **What happens next:**\n• Your message has been added to our queue\n• A support agent will respond as soon as available\n• You'll receive a notification when they reply\n\n💡 **While you wait:**\n• You can continue browsing our website\n• Check our FAQ for quick answers\n• Leave your email to receive updates\n\nWe typically respond within 15-30 minutes during business hours. Thank you for your patience! 🙏";
      }
    }

    // Save bot response
    const botMessageId = uuidv4();
    await insert('chat_messages', {
      id: botMessageId,
      conversation_id: conversationId,
      sender_type: 'bot',
      message: botResponse,
      knowledge_id: knowledgeId,
      is_answered: isAnswered
    });

    // Update user message as answered if we found an answer
    if (isAnswered) {
      await update('chat_messages', { is_answered: true }, 'id = ?', [userMessageId]);
    }

    // Get agent info if routed
    let agentInfo = null;
    if (routedToAgent) {
      const agents = await query(
        'SELECT name, avatar FROM support_agents WHERE id = (SELECT assigned_agent_id FROM chat_conversations WHERE id = ?)',
        [conversationId]
      );
      if (agents.length > 0) {
        agentInfo = { name: agents[0].name, avatar: agents[0].avatar };
      }
    }

    res.json({
      conversationId,
      answer: botResponse,
      isFromKnowledgeBase: isAnswered,
      knowledgeId,
      routedToAgent,
      agentInfo
    });
  } catch (error) {
    console.error('[Chat] Ask error:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// Get conversation history
router.get('/history/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const conversation = await query(
      `SELECT c.*, a.name as agent_name, a.avatar as agent_avatar, a.status as agent_status 
       FROM chat_conversations c 
       LEFT JOIN support_agents a ON c.assigned_agent_id = a.id 
       WHERE c.session_id = ? 
       ORDER BY c.created_at DESC LIMIT 1`,
      [sessionId]
    );
    
    if (conversation.length === 0) {
      return res.json({ messages: [], status: null });
    }
    
    // If conversation is resolved, return empty to clear chat on client
    if (conversation[0].status === 'resolved') {
      return res.json({ 
        messages: [], 
        status: 'resolved',
        conversationId: conversation[0].id 
      });
    }
    
    const messages = await query(
      `SELECT m.*, a.name as agent_name, a.avatar as agent_avatar 
       FROM chat_messages m 
       LEFT JOIN support_agents a ON m.agent_id = a.id
       WHERE m.conversation_id = ? 
       ORDER BY m.created_at ASC`,
      [conversation[0].id]
    );
    
    res.json({
      conversationId: conversation[0].id,
      topic: conversation[0].topic,
      status: conversation[0].status,
      hasAgent: !!conversation[0].assigned_agent_id,
      agentInfo: conversation[0].assigned_agent_id ? {
        name: conversation[0].agent_name,
        avatar: conversation[0].agent_avatar,
        status: conversation[0].agent_status
      } : null,
      messages: messages.map(m => ({
        id: m.id,
        type: m.sender_type,
        text: m.message,
        timestamp: m.created_at,
        agent_name: m.agent_name,
        agent_avatar: m.agent_avatar
      }))
    });
  } catch (error) {
    console.error('[Chat] History error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ============================================
// ADMIN ENDPOINTS (for super admin)
// ============================================

// Get all knowledge base entries
router.get('/knowledge', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const entries = await query(
      'SELECT * FROM chat_knowledge_base ORDER BY category, priority DESC, created_at DESC'
    );
    res.json(entries);
  } catch (error) {
    console.error('[Chat] Get knowledge error:', error);
    res.status(500).json({ error: 'Failed to fetch knowledge base' });
  }
});

// Add knowledge base entry
router.post('/knowledge', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { category, question, keywords, answer, priority } = req.body;
    
    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }

    const id = uuidv4();
    await insert('chat_knowledge_base', {
      id,
      category: category || 'general',
      question,
      keywords: keywords || '',
      answer,
      priority: priority || 0,
      active: true
    });

    const entry = await query('SELECT * FROM chat_knowledge_base WHERE id = ?', [id]);
    res.status(201).json(entry[0]);
  } catch (error) {
    console.error('[Chat] Add knowledge error:', error);
    res.status(500).json({ error: 'Failed to add knowledge entry' });
  }
});

// Update knowledge base entry
router.patch('/knowledge/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, keywords, answer, priority, active } = req.body;

    const updates = {};
    if (category !== undefined) updates.category = category;
    if (question !== undefined) updates.question = question;
    if (keywords !== undefined) updates.keywords = keywords;
    if (answer !== undefined) updates.answer = answer;
    if (priority !== undefined) updates.priority = priority;
    if (active !== undefined) updates.active = active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await update('chat_knowledge_base', updates, 'id = ?', [id]);
    const entry = await query('SELECT * FROM chat_knowledge_base WHERE id = ?', [id]);
    
    if (entry.length === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json(entry[0]);
  } catch (error) {
    console.error('[Chat] Update knowledge error:', error);
    res.status(500).json({ error: 'Failed to update knowledge entry' });
  }
});

// Delete knowledge base entry
router.delete('/knowledge/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await remove('chat_knowledge_base', 'id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Chat] Delete knowledge error:', error);
    res.status(500).json({ error: 'Failed to delete knowledge entry' });
  }
});

// Get all conversations (for admin review)
router.get('/conversations', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    
    let sql = `
      SELECT c.*, 
        (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
        (SELECT message FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM chat_conversations c
    `;
    
    const params = [];
    if (status) {
      sql += ' WHERE c.status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY c.updated_at DESC LIMIT ?';
    params.push(parseInt(limit));

    const conversations = await query(sql, params);
    res.json(conversations);
  } catch (error) {
    console.error('[Chat] Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get single conversation with messages
router.get('/conversations/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const conversation = await query('SELECT * FROM chat_conversations WHERE id = ?', [id]);
    if (conversation.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await query(
      `SELECT m.*, k.question as knowledge_question 
       FROM chat_messages m 
       LEFT JOIN chat_knowledge_base k ON m.knowledge_id = k.id
       WHERE m.conversation_id = ? 
       ORDER BY m.created_at ASC`,
      [id]
    );

    res.json({
      ...conversation[0],
      messages
    });
  } catch (error) {
    console.error('[Chat] Get conversation error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Update conversation status
router.patch('/conversations/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'resolved', 'pending_review', 'escalated'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await update('chat_conversations', { status }, 'id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    console.error('[Chat] Update conversation error:', error);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// Admin reply to conversation
router.post('/conversations/:id/reply', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const messageId = uuidv4();
    await insert('chat_messages', {
      id: messageId,
      conversation_id: id,
      sender_type: 'admin',
      message,
      is_answered: true
    });

    // Update conversation status to resolved
    await update('chat_conversations', { status: 'resolved' }, 'id = ?', [id]);

    res.status(201).json({ id: messageId, message });
  } catch (error) {
    console.error('[Chat] Admin reply error:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// Get chat statistics
router.get('/stats', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const [totalConversations] = await query('SELECT COUNT(*) as count FROM chat_conversations');
    const [pendingReview] = await query('SELECT COUNT(*) as count FROM chat_conversations WHERE status = "pending_review"');
    const [totalMessages] = await query('SELECT COUNT(*) as count FROM chat_messages');
    const [answeredFromKB] = await query('SELECT COUNT(*) as count FROM chat_messages WHERE is_answered = 1 AND sender_type = "user"');
    const [knowledgeEntries] = await query('SELECT COUNT(*) as count FROM chat_knowledge_base WHERE active = 1');

    res.json({
      totalConversations: totalConversations.count,
      pendingReview: pendingReview.count,
      totalMessages: totalMessages.count,
      answeredFromKB: answeredFromKB.count,
      knowledgeEntries: knowledgeEntries.count
    });
  } catch (error) {
    console.error('[Chat] Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
