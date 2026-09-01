'use strict';
const express = require('express');
const router  = express.Router();
const pool    = require('../db');

// GET /api/roles/all  — ALL roles including Admin (for welcome page)
router.get('/all', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT role_id AS "roleId", TRIM(role_name) AS "roleName"
      FROM role_table
      ORDER BY role_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roles  — all roles EXCEPT Admin (for user-create dropdown)
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT role_id AS "roleId", TRIM(role_name) AS "roleName", feature_allowed AS "featureAllowed"
      FROM role_table
      WHERE TRIM(role_name) != 'Admin'
      ORDER BY role_id
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/roles/features/:roleId  — features allowed for a role
router.get('/features/:roleId', async (req, res) => {
  try {
    // Get role's feature_allowed IDs
    const roleRes = await pool.query(
      `SELECT feature_allowed AS "featureAllowed" FROM role_table WHERE role_id = $1`,
      [req.params.roleId]
    );
    if (!roleRes.rows.length) return res.status(404).json({ error: 'Role not found' });

    const ids = roleRes.rows[0].featureAllowed.split(',').map(s => parseInt(s.trim()));

    // Fetch those features
    const featRes = await pool.query(`
      SELECT feature_id AS "featureId",
             TRIM(feature_name) AS "featureName",
             permissions
      FROM features_table
      WHERE feature_id = ANY($1::int[])
      ORDER BY feature_id
    `, [ids]);

    res.json(featRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
