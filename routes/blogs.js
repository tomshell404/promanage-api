import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, insert, update, remove } from '../config/database.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// Get all blogs (admin - includes drafts)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const blogs = await query(
      `SELECT * FROM blogs ORDER BY created_at DESC`
    );
    res.json(blogs);
  } catch (err) {
    console.error('Get blogs error:', err);
    res.status(500).json({ error: 'Failed to fetch blogs' });
  }
});

// Get public blogs (published only)
router.get('/public', async (req, res) => {
  try {
    const blogs = await query(
      `SELECT id, title, slug, excerpt, cover_image, author_name, author_avatar, 
              category, tags, published_at, read_time, is_featured
       FROM blogs 
       WHERE published_at IS NOT NULL 
       ORDER BY is_featured DESC, published_at DESC`
    );
    res.json(blogs);
  } catch (err) {
    console.error('Get public blogs error:', err);
    res.status(500).json({ error: 'Failed to fetch blogs' });
  }
});

// Get single public blog by slug
router.get('/public/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const posts = await query(
      `SELECT * FROM blogs WHERE slug = ? AND published_at IS NOT NULL`,
      [slug]
    );
    
    if (posts.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    const post = posts[0];
    
    // Get related posts (same category, excluding current)
    const related = await query(
      `SELECT id, title, slug, cover_image, read_time, published_at
       FROM blogs 
       WHERE category = ? AND id != ? AND published_at IS NOT NULL
       ORDER BY published_at DESC
       LIMIT 3`,
      [post.category, post.id]
    );
    
    res.json({ post, related });
  } catch (err) {
    console.error('Get blog by slug error:', err);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  }
});

// Create blog post
router.post('/', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      cover_image,
      category,
      tags,
      is_featured,
      published_at,
      read_time,
      author_name,
      author_avatar
    } = req.body;
    
    if (!title || !slug) {
      return res.status(400).json({ error: 'Title and slug are required' });
    }
    
    // Check if slug already exists
    const existing = await query('SELECT id FROM blogs WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'A blog with this slug already exists' });
    }
    
    const id = uuidv4();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    await insert('blogs', {
      id,
      title,
      slug,
      excerpt: excerpt || '',
      content: content || '',
      cover_image: cover_image || '',
      category: category || '',
      tags: tags || '',
      is_featured: is_featured ? 1 : 0,
      published_at: published_at ? new Date(published_at).toISOString().slice(0, 19).replace('T', ' ') : null,
      read_time: read_time || 1,
      author_name: author_name || 'Admin',
      author_avatar: author_avatar || '',
      created_at: now,
      updated_at: now
    });
    
    res.status(201).json({ id, message: 'Blog post created' });
  } catch (err) {
    console.error('Create blog error:', err);
    res.status(500).json({ error: 'Failed to create blog post' });
  }
});

// Update blog post
router.put('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      slug,
      excerpt,
      content,
      cover_image,
      category,
      tags,
      is_featured,
      published_at,
      read_time,
      author_name,
      author_avatar
    } = req.body;
    
    // Check if blog exists
    const existing = await query('SELECT id FROM blogs WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    // Check if slug is taken by another post
    if (slug) {
      const slugCheck = await query('SELECT id FROM blogs WHERE slug = ? AND id != ?', [slug, id]);
      if (slugCheck.length > 0) {
        return res.status(400).json({ error: 'A blog with this slug already exists' });
      }
    }
    
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    
    const updateData = {
      updated_at: now
    };
    
    if (title !== undefined) updateData.title = title;
    if (slug !== undefined) updateData.slug = slug;
    if (excerpt !== undefined) updateData.excerpt = excerpt;
    if (content !== undefined) updateData.content = content;
    if (cover_image !== undefined) updateData.cover_image = cover_image;
    if (category !== undefined) updateData.category = category;
    if (tags !== undefined) updateData.tags = tags;
    if (is_featured !== undefined) updateData.is_featured = is_featured ? 1 : 0;
    if (published_at !== undefined) {
      updateData.published_at = published_at ? new Date(published_at).toISOString().slice(0, 19).replace('T', ' ') : null;
    }
    if (read_time !== undefined) updateData.read_time = read_time;
    if (author_name !== undefined) updateData.author_name = author_name;
    if (author_avatar !== undefined) updateData.author_avatar = author_avatar;
    
    await update('blogs', updateData, 'id = ?', [id]);
    
    res.json({ message: 'Blog post updated' });
  } catch (err) {
    console.error('Update blog error:', err);
    res.status(500).json({ error: 'Failed to update blog post' });
  }
});

// Delete blog post
router.delete('/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if blog exists
    const existing = await query('SELECT id FROM blogs WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    await remove('blogs', 'id = ?', [id]);
    
    res.json({ message: 'Blog post deleted' });
  } catch (err) {
    console.error('Delete blog error:', err);
    res.status(500).json({ error: 'Failed to delete blog post' });
  }
});

export default router;
