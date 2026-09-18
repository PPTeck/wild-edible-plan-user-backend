'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 8080;

// Ensure upload dirs exist on startup
['uploads', 'uploads/observations', 'uploads/identification', 'uploads/gdal_output']
  .forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve GDAL-generated PNGs as static files
app.use('/gdal_output', express.static(path.join(__dirname, '../uploads/gdal_output')));
app.use('/uploads',     express.static(path.join(__dirname, '../uploads')));

// ── Routes ────────────────────────────────────────────────
app.use('/api/plants',       require('./routes/plants'));
app.use('/api/terrain',      require('./routes/terrain'));
app.use('/api/observations', require('./routes/observations'));
app.use('/api/identify',     require('./routes/identify'));
app.use('/api/roles',        require('./routes/roles'));
app.use('/api/users',        require('./routes/users'));
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/field-user', require('./routes/fielduserplantroutes'));

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () =>
  console.log(`✅  Plant API Node.js server running on http://192.168.29.217:${PORT}`)
);
