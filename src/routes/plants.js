'use strict';
const express       = require('express');
const router        = express.Router();
const pool          = require('../db');
const { encrypt }   = require('../crypto');

const SELECT = `
  SELECT
    plant_id            AS "plantId",
    image_id            AS "imageId",
    scientific_name     AS "scientificName",
    common_name         AS "commonName",
    family,
    habitat,
    distribution,
    edible_parts        AS "edibleParts",
    nutritional_value   AS "nutritionalValue",
    flowering_season    AS "floweringSeason",
    conservation_status AS "conservationStatus",
    image_url           AS "imageUrl",
    latitude,
    longitude,
    uploaded_by         AS "uploadedBy",
    verified_status       AS "verifiedStatus",
    created_date        AS "createdDate",
    version,
    deleted_at          AS "deletedAt"
  FROM plant_table
  WHERE deleted_at IS NULL
`;

// GET /api/plants/all
router.get('/all', async (_req, res) => {
  try {
    const { rows } = await pool.query(SELECT + ' ORDER BY plant_id');
    res.json({ data: encrypt(JSON.stringify(rows)) });
  } catch (err) {
    console.error('GET /plants/all:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plants/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(SELECT + ' AND plant_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Plant not found' });
    res.json({ data: encrypt(JSON.stringify(rows[0])) });
  } catch (err) {
    console.error('GET /plants/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plants
router.post('/', async (req, res) => {
  const { imageId, scientificName, commonName, family, habitat, distribution,
          edibleParts, nutritionalValue, floweringSeason, conservationStatus,
          imageUrl, latitude, longitude, uploadedBy, verifiedStatus } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO plant_table
        (image_id, scientific_name, common_name, family, habitat, distribution,
         edible_parts, nutritional_value, flowering_season, conservation_status,
         image_url, latitude, longitude, uploaded_by, verified_status, created_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
      RETURNING plant_id AS "plantId"
    `, [imageId, scientificName, commonName, family, habitat, distribution,
        edibleParts, nutritionalValue, floweringSeason, conservationStatus,
        imageUrl, latitude, longitude, uploadedBy, verifiedStatus ?? false]);
    res.status(201).json({ plantId: rows[0].plantId });
  } catch (err) {
    console.error('POST /plants:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/plants/:id
router.put('/:id', async (req, res) => {
  const { scientificName, commonName, family, habitat, distribution, edibleParts,
          nutritionalValue, floweringSeason, conservationStatus, imageUrl,
          latitude, longitude, verifiedStatus } = req.body;
  try {
    await pool.query(`
      UPDATE plant_table SET
        scientific_name=$1, common_name=$2, family=$3, habitat=$4,
        distribution=$5, edible_parts=$6, nutritional_value=$7,
        flowering_season=$8, conservation_status=$9, image_url=$10,
        latitude=$11, longitude=$12, verified_status=$13
      WHERE plant_id=$14 AND deleted_at IS NULL
    `, [scientificName, commonName, family, habitat, distribution, edibleParts,
        nutritionalValue, floweringSeason, conservationStatus, imageUrl,
        latitude, longitude, verifiedStatus, req.params.id]);
    res.json({ updated: true });
  } catch (err) {
    console.error('PUT /plants/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
