import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// ========================
// PUBLIC ROUTES
// ========================

// Get all published jobs (public)
router.get('/public', async (req, res) => {
  try {
    const jobs = await query(
      `SELECT id, title, slug, department, location, job_type, experience_level,
              salary_min, salary_max, salary_currency, description, skills,
              is_featured, application_deadline, published_at
       FROM job_postings 
       WHERE is_published = 1 
       ORDER BY is_featured DESC, published_at DESC`
    );
    res.json(jobs);
  } catch (err) {
    console.error('Get public jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// Get single job by slug (public)
router.get('/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const jobs = await query(
      `SELECT * FROM job_postings WHERE slug = ? AND is_published = 1`,
      [slug]
    );
    
    if (jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Get application count
    const countResult = await query(
      `SELECT COUNT(*) as count FROM job_applications WHERE job_id = ?`,
      [jobs[0].id]
    );
    
    res.json({ 
      job: jobs[0],
      applicationCount: countResult[0]?.count || 0
    });
  } catch (err) {
    console.error('Get job by slug error:', err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Submit job application (public)
router.post('/apply/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const {
      first_name, last_name, email, phone, address, city, country,
      resume_url, cover_letter, linkedin_url, portfolio_url, website_url,
      current_company, current_title, experience_years, education_level,
      education_field, university, expected_salary, salary_currency,
      notice_period, available_start_date, how_heard, additional_info
    } = req.body;
    
    // Validate required fields
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'First name, last name, and email are required' });
    }
    
    // Check if job exists and is published
    const jobs = await query(
      `SELECT id, title FROM job_postings WHERE id = ? AND is_published = 1`,
      [jobId]
    );
    
    if (jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found or no longer accepting applications' });
    }
    
    // Check for duplicate application
    const existing = await query(
      `SELECT id FROM job_applications WHERE job_id = ? AND email = ?`,
      [jobId, email]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'You have already applied for this position' });
    }
    
    const id = uuidv4();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    await insert('job_applications', {
      id,
      job_id: jobId,
      first_name,
      last_name,
      email,
      phone: phone || null,
      address: address || null,
      city: city || null,
      country: country || null,
      resume_url: resume_url || null,
      cover_letter: cover_letter || null,
      linkedin_url: linkedin_url || null,
      portfolio_url: portfolio_url || null,
      website_url: website_url || null,
      current_company: current_company || null,
      current_title: current_title || null,
      experience_years: experience_years || 0,
      education_level: education_level || 'bachelor',
      education_field: education_field || null,
      university: university || null,
      expected_salary: expected_salary || null,
      salary_currency: salary_currency || 'USD',
      notice_period: notice_period || null,
      available_start_date: available_start_date || null,
      how_heard: how_heard || null,
      additional_info: additional_info || null,
      status: 'pending',
      created_at: now,
      updated_at: now
    });
    
    res.status(201).json({ 
      id, 
      message: 'Application submitted successfully',
      jobTitle: jobs[0].title
    });
  } catch (err) {
    console.error('Submit application error:', err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// ========================
// ADMIN ROUTES
// ========================

// Get all jobs (admin)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const jobs = await query(
      `SELECT jp.*, 
              (SELECT COUNT(*) FROM job_applications WHERE job_id = jp.id) as application_count
       FROM job_postings jp
       ORDER BY jp.created_at DESC`
    );
    res.json(jobs);
  } catch (err) {
    console.error('Get all jobs error:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

// Get single job (admin)
router.get('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const jobs = await query(`SELECT * FROM job_postings WHERE id = ?`, [id]);
    
    if (jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json(jobs[0]);
  } catch (err) {
    console.error('Get job error:', err);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

// Create job posting (admin)
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const {
      title, slug, department, location, job_type, experience_level,
      salary_min, salary_max, salary_currency, description, requirements,
      responsibilities, benefits, skills, is_published, is_featured,
      application_deadline
    } = req.body;
    
    if (!title || !slug) {
      return res.status(400).json({ error: 'Title and slug are required' });
    }
    
    // Check if slug already exists
    const existing = await query('SELECT id FROM job_postings WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'A job with this slug already exists' });
    }
    
    const id = uuidv4();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    await insert('job_postings', {
      id,
      title,
      slug,
      department: department || null,
      location: location || null,
      job_type: job_type || 'full-time',
      experience_level: experience_level || 'mid',
      salary_min: salary_min || null,
      salary_max: salary_max || null,
      salary_currency: salary_currency || 'USD',
      description: description || '',
      requirements: requirements || '',
      responsibilities: responsibilities || '',
      benefits: benefits || '',
      skills: skills || '',
      is_published: is_published ? 1 : 0,
      is_featured: is_featured ? 1 : 0,
      application_deadline: application_deadline || null,
      published_at: is_published ? now : null,
      created_at: now,
      updated_at: now
    });
    
    res.status(201).json({ id, message: 'Job posting created' });
  } catch (err) {
    console.error('Create job error:', err);
    res.status(500).json({ error: 'Failed to create job posting' });
  }
});

// Update job posting (admin)
router.put('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title, slug, department, location, job_type, experience_level,
      salary_min, salary_max, salary_currency, description, requirements,
      responsibilities, benefits, skills, is_published, is_featured,
      application_deadline
    } = req.body;
    
    // Check if job exists
    const existing = await query('SELECT id, is_published FROM job_postings WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    // Check if slug is taken by another job
    if (slug) {
      const slugCheck = await query('SELECT id FROM job_postings WHERE slug = ? AND id != ?', [slug, id]);
      if (slugCheck.length > 0) {
        return res.status(400).json({ error: 'A job with this slug already exists' });
      }
    }
    
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const wasPublished = existing[0].is_published;
    
    const updateData = { updated_at: now };
    
    if (title !== undefined) updateData.title = title;
    if (slug !== undefined) updateData.slug = slug;
    if (department !== undefined) updateData.department = department;
    if (location !== undefined) updateData.location = location;
    if (job_type !== undefined) updateData.job_type = job_type;
    if (experience_level !== undefined) updateData.experience_level = experience_level;
    if (salary_min !== undefined) updateData.salary_min = salary_min;
    if (salary_max !== undefined) updateData.salary_max = salary_max;
    if (salary_currency !== undefined) updateData.salary_currency = salary_currency;
    if (description !== undefined) updateData.description = description;
    if (requirements !== undefined) updateData.requirements = requirements;
    if (responsibilities !== undefined) updateData.responsibilities = responsibilities;
    if (benefits !== undefined) updateData.benefits = benefits;
    if (skills !== undefined) updateData.skills = skills;
    if (is_published !== undefined) {
      updateData.is_published = is_published ? 1 : 0;
      if (is_published && !wasPublished) {
        updateData.published_at = now;
      }
    }
    if (is_featured !== undefined) updateData.is_featured = is_featured ? 1 : 0;
    if (application_deadline !== undefined) updateData.application_deadline = application_deadline;
    
    await update('job_postings', updateData, 'id = ?', [id]);
    
    res.json({ message: 'Job posting updated' });
  } catch (err) {
    console.error('Update job error:', err);
    res.status(500).json({ error: 'Failed to update job posting' });
  }
});

// Delete job posting (admin)
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await query('SELECT id FROM job_postings WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    await remove('job_postings', 'id = ?', [id]);
    
    res.json({ message: 'Job posting deleted' });
  } catch (err) {
    console.error('Delete job error:', err);
    res.status(500).json({ error: 'Failed to delete job posting' });
  }
});

// ========================
// APPLICATION ROUTES (Admin)
// ========================

// Get all applications (admin)
router.get('/applications/all', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { status, job_id } = req.query;
    
    let sql = `
      SELECT ja.*, jp.title as job_title, jp.department as job_department
      FROM job_applications ja
      LEFT JOIN job_postings jp ON ja.job_id = jp.id
      WHERE 1=1
    `;
    const params = [];
    
    if (status && status !== 'all') {
      sql += ' AND ja.status = ?';
      params.push(status);
    }
    
    if (job_id && job_id !== 'all') {
      sql += ' AND ja.job_id = ?';
      params.push(job_id);
    }
    
    sql += ' ORDER BY ja.created_at DESC';
    
    const applications = await query(sql, params);
    res.json(applications);
  } catch (err) {
    console.error('Get applications error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get single application (admin)
router.get('/applications/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const applications = await query(
      `SELECT ja.*, jp.title as job_title, jp.department as job_department, jp.slug as job_slug
       FROM job_applications ja
       LEFT JOIN job_postings jp ON ja.job_id = jp.id
       WHERE ja.id = ?`,
      [id]
    );
    
    if (applications.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    
    res.json(applications[0]);
  } catch (err) {
    console.error('Get application error:', err);
    res.status(500).json({ error: 'Failed to fetch application' });
  }
});

// Update application status/notes (admin)
router.put('/applications/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rating, internal_notes } = req.body;
    
    const existing = await query('SELECT id FROM job_applications WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const updateData = { updated_at: now };
    
    if (status !== undefined) {
      updateData.status = status;
      updateData.reviewed_at = now;
      updateData.reviewed_by = req.user?.id || null;
    }
    if (rating !== undefined) updateData.rating = rating;
    if (internal_notes !== undefined) updateData.internal_notes = internal_notes;
    
    await update('job_applications', updateData, 'id = ?', [id]);
    
    res.json({ message: 'Application updated' });
  } catch (err) {
    console.error('Update application error:', err);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

// Delete application (admin)
router.delete('/applications/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await query('SELECT id FROM job_applications WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    
    await remove('job_applications', 'id = ?', [id]);
    
    res.json({ message: 'Application deleted' });
  } catch (err) {
    console.error('Delete application error:', err);
    res.status(500).json({ error: 'Failed to delete application' });
  }
});

// Get application stats (admin)
router.get('/stats/overview', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const [totalJobs] = await query('SELECT COUNT(*) as count FROM job_postings');
    const [publishedJobs] = await query('SELECT COUNT(*) as count FROM job_postings WHERE is_published = 1');
    const [totalApplications] = await query('SELECT COUNT(*) as count FROM job_applications');
    const [pendingApplications] = await query('SELECT COUNT(*) as count FROM job_applications WHERE status = "pending"');
    const [thisWeekApplications] = await query(
      'SELECT COUNT(*) as count FROM job_applications WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    
    const statusBreakdown = await query(
      'SELECT status, COUNT(*) as count FROM job_applications GROUP BY status'
    );
    
    res.json({
      totalJobs: totalJobs.count,
      publishedJobs: publishedJobs.count,
      totalApplications: totalApplications.count,
      pendingApplications: pendingApplications.count,
      thisWeekApplications: thisWeekApplications.count,
      statusBreakdown
    });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
