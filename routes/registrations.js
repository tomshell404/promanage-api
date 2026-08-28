import express from 'express';
import { query, queryOne, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../utils/auditLogger.js';

const router = express.Router();

// Public endpoint - Submit new registration
router.post('/', async (req, res) => {
  try {
    const {
      businessName,
      businessType,
      businessAddress,
      city,
      country,
      numberOfLocations,
      estimatedStaff,
      contactName,
      contactEmail,
      contactPhone,
      contactPosition,
      howDidYouHear,
      additionalNotes,
      selectedPlan,
    } = req.body;

    // Validate required fields
    if (!businessName || !businessType || !city || !contactName || !contactEmail || !contactPhone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email already registered
    const existing = await queryOne(
      'SELECT id FROM online_registrations WHERE contact_email = ? AND status != "rejected"',
      [contactEmail]
    );
    if (existing) {
      return res.status(400).json({ error: 'A registration with this email already exists' });
    }

    // Insert registration
    const result = await insert('online_registrations', {
      business_name: businessName,
      business_type: businessType,
      business_address: businessAddress || null,
      city: city,
      country: country || 'Ethiopia',
      number_of_locations: numberOfLocations || '1',
      estimated_staff: estimatedStaff || null,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      contact_position: contactPosition || null,
      how_did_you_hear: howDidYouHear || null,
      additional_notes: additionalNotes || null,
      selected_plan: selectedPlan || 'free_trial',
      status: 'pending',
    });

    console.log('[Registrations] New registration submitted:', contactEmail, businessName);

    // Log audit (system action - no authenticated user)
    await logAudit({
      req,
      category: 'registration',
      action: AuditActions.REGISTRATION_SUBMIT,
      description: `New registration: ${businessName} (${contactEmail})`,
      actorName: contactName,
      metadata: {
        registrationId: result.insertId,
        businessName,
        businessType,
        city,
        contactEmail,
        selectedPlan: selectedPlan || 'free_trial',
      },
    });

    res.status(201).json({
      success: true,
      message: 'Registration submitted successfully',
      registrationId: result.insertId,
    });
  } catch (err) {
    console.error('[Registrations] Error creating registration:', err);
    res.status(500).json({ error: 'Failed to submit registration' });
  }
});

// Protected endpoints - Super admin only

// Get all registrations
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let sql = 'SELECT * FROM online_registrations';
    const params = [];
    
    if (status && status !== 'all') {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const registrations = await query(sql, params);
    
    // Get counts by status
    const counts = await query(
      `SELECT status, COUNT(*) as count FROM online_registrations GROUP BY status`
    );
    const statusCounts = counts.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, { pending: 0, contacted: 0, approved: 0, rejected: 0 });

    res.json({ registrations, counts: statusCounts });
  } catch (err) {
    console.error('[Registrations] Error fetching registrations:', err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

// Get single registration
router.get('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const registration = await queryOne(
      'SELECT * FROM online_registrations WHERE id = ?',
      [req.params.id]
    );
    
    if (!registration) {
      return res.status(404).json({ error: 'Registration not found' });
    }

    res.json(registration);
  } catch (err) {
    console.error('[Registrations] Error fetching registration:', err);
    res.status(500).json({ error: 'Failed to fetch registration' });
  }
});

// Update registration status
router.patch('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    
    const validStatuses = ['pending', 'contacted', 'approved', 'rejected'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updateData = {};

    if (status) {
      updateData.status = status;
    }
    if (notes !== undefined) {
      updateData.admin_notes = notes;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await update('online_registrations', updateData, 'id = ?', [req.params.id]);

    const updated = await queryOne(
      'SELECT * FROM online_registrations WHERE id = ?',
      [req.params.id]
    );

    console.log('[Registrations] Updated registration:', req.params.id, 'status:', status);

    // Log audit
    await logAudit({
      req,
      category: 'registration',
      action: AuditActions.REGISTRATION_UPDATE,
      description: `Updated registration #${req.params.id}: ${updated?.business_name} - Status: ${status || 'unchanged'}`,
      metadata: {
        registrationId: req.params.id,
        businessName: updated?.business_name,
        newStatus: status,
        hasNotes: !!notes,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('[Registrations] Error updating registration:', err);
    res.status(500).json({ error: 'Failed to update registration' });
  }
});

// Delete registration
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    // Get registration info before deletion for audit
    const registration = await queryOne(
      'SELECT business_name, contact_email FROM online_registrations WHERE id = ?',
      [req.params.id]
    );

    await remove('online_registrations', 'id = ?', [req.params.id]);
    console.log('[Registrations] Deleted registration:', req.params.id);

    // Log audit
    await logAudit({
      req,
      category: 'registration',
      action: AuditActions.REGISTRATION_DELETE,
      description: `Deleted registration #${req.params.id}: ${registration?.business_name || 'Unknown'}`,
      metadata: {
        registrationId: req.params.id,
        businessName: registration?.business_name,
        contactEmail: registration?.contact_email,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Registrations] Error deleting registration:', err);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

export default router;
