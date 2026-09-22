'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const pool    = require('../db');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/identification'),
  filename:    (_req, file,  cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/identify/
router.post('/', upload.single('image'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM plant_table WHERE deleted_at IS NULL ORDER BY plant_id',
    );
    const rng = Math.random;
    const results = rows
      .map(p => ({
        plantId:        p.plant_id,
        scientificName: p.scientific_name,
        commonName:     p.common_name,
        family:         p.family,
        imageUrl:       p.image_url,
        confidence:     Math.round((10 + rng() * 85) * 10) / 10,
        expertVerified: false,
        identifiedAt:   new Date().toISOString(),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
