import { Router } from 'express';
import fs from 'fs';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { logAudit } from '../utils/auditLogger.js';
import {
  getBackupStatus,
  listBackups,
  createBackup,
  getBackupFile,
  deleteBackup,
} from '../services/backupService.js';

const router = Router();

router.use(authenticate, requireSuperAdmin);

router.get('/status', async (req, res) => {
  try {
    res.json(await getBackupStatus());
  } catch (err) {
    console.error('Backup status error:', err);
    res.status(500).json({ error: 'Failed to load backup status' });
  }
});

router.get('/history', async (req, res) => {
  try {
    res.json(await listBackups({
      q: req.query.q,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }));
  } catch (err) {
    console.error('Backup history error:', err);
    res.status(500).json({ error: 'Failed to load backup history' });
  }
});

router.post('/create', async (req, res) => {
  try {
    const backup = await createBackup(req);
    res.json(backup);
  } catch (err) {
    console.error('Backup create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create backup' });
  }
});

router.get('/:id/download', async (req, res) => {
  try {
    const result = await getBackupFile(req.params.id);
    if (!result) return res.status(404).json({ error: 'Backup not found' });
    if (result.missing) return res.status(404).json({ error: 'Backup file missing on disk' });

    await logAudit({
      req,
      category: 'system',
      action: 'backup_download',
      description: `Downloaded database backup ${result.row.filename}`,
      metadata: { backupId: result.row.id, filename: result.row.filename },
    });

    res.download(result.filePath, result.row.filename);
  } catch (err) {
    console.error('Backup download error:', err);
    res.status(500).json({ error: 'Failed to download backup' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await deleteBackup(req.params.id, req));
  } catch (err) {
    console.error('Backup delete error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to delete backup' });
  }
});

export default router;
