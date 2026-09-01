'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const pool    = require('../db');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/observations'),
  filename:    (_req, file,  cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/observations/submit
router.post('/submit', upload.single('image'), async (req, res) => {
  const { plantId, userId, latitude, longitude } = req.body;
  const imagePath = req.file ? req.file.path : null;
  try {
    const { rows } = await pool.query(`
      INSERT INTO observation_table
        (plant_id, user_id, observation_image, observation_status, latitude, longitude, time_stamp)
      VALUES ($1,$2,$3,'PENDING',$4,$5,NOW())
      RETURNING *
    `, [plantId, userId, imagePath, latitude, longitude]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/observations/pending
router.get('/pending', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM observation_table WHERE observation_status='PENDING' ORDER BY time_stamp DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/observations/all
router.get('/all', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM observation_table ORDER BY time_stamp DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/observations/:id/approve
router.put('/:id/approve', async (req, res) => {
  const { feedback = '' } = req.query;
  try {
    const { rows } = await pool.query(
      "UPDATE observation_table SET observation_status='APPROVED', feedback=$1 WHERE observation_id=$2 RETURNING *",
      [feedback, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/observations/:id/reject
router.put('/:id/reject', async (req, res) => {
  const { feedback = '' } = req.query;
  try {
    const { rows } = await pool.query(
      "UPDATE observation_table SET observation_status='REJECTED', feedback=$1 WHERE observation_id=$2 RETURNING *",
      [feedback, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
