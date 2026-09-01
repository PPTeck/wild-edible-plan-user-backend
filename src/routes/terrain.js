'use strict';
/**
 * Terrain shaded relief using GDAL (node-gdal-async).
 *
 * POST /api/terrain/execute        — start job → { jobId }
 * GET  /api/terrain/status/:jobId  — { status, progress }
 * GET  /api/terrain/output/:jobId  — { fileName, extent }
 * PNG served as static:  GET /gdal_output/<fileName>
 */
const express = require('express');
const router  = express.Router();
const gdal    = require('gdal-async');
const path    = require('path');

const OUTPUT_DIR = path.join(__dirname, '../../uploads/gdal_output');
const DEM_FILE   = process.env.DEM_FILE || path.join(__dirname, '../../data/dem.tif');

// Simple in-memory job store
const jobs = {};

function newJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── GDAL hillshade ────────────────────────────────────────
async function runHillshade(jobId, aoi, azimuth, altitude) {
  const job     = jobs[jobId];
  const outFile = path.join(OUTPUT_DIR, `ShadedRelief_${jobId}.png`);
  const [minLon, minLat, maxLon, maxLat] = aoi;

  try {
    // Check DEM file exists before opening
    if (!require('fs').existsSync(DEM_FILE)) {
      throw new Error(
        `DEM file not found: ${DEM_FILE}\n` +
        `Run: node scripts/create_test_dem.js  OR  set DEM_FILE in .env`
      );
    }

    job.progress = 10;

    // Open DEM GeoTIFF
    const demDs   = await gdal.openAsync(DEM_FILE);
    const demBand = demDs.bands.get(1);
    const gt      = demDs.geoTransform;   // [originX, pixelW, 0, originY, 0, pixelH]

    job.progress = 25;

    // Convert AOI bbox to pixel window
    const xOff  = Math.max(0, Math.floor((minLon - gt[0]) / gt[1]));
    const yOff  = Math.max(0, Math.floor((maxLat - gt[3]) / gt[5]));
    const xSize = Math.max(1, Math.ceil((maxLon - minLon) / Math.abs(gt[1])));
    const ySize = Math.max(1, Math.ceil((maxLat - minLat) / Math.abs(gt[5])));

    job.progress = 40;

    // Read elevation block
    const elev = await demBand.pixels.readAsync(xOff, yOff, xSize, ySize);

    job.progress = 55;

    // Hillshade per pixel
    const az  = (azimuth  * Math.PI) / 180;
    const alt = (altitude * Math.PI) / 180;
    const out = new Uint8Array(xSize * ySize);

    for (let r = 0; r < ySize; r++) {
      for (let c = 0; c < xSize; c++) {
        const i  = r * xSize + c;
        const z  = elev[i]           ?? 0;
        const zR = elev[i + 1]       ?? z;
        const zD = elev[i + xSize]   ?? z;

        const dzdx   = (zR - z) / Math.abs(gt[1]);
        const dzdy   = (z - zD) / Math.abs(gt[5]);
        const slope  = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        const aspect = Math.atan2(-dzdy, dzdx);
        const shade  = Math.cos(alt) * Math.cos(slope)
                     + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);

        out[i] = Math.max(0, Math.min(255, Math.round(shade * 255)));
      }
    }

    job.progress = 75;

    // PNG driver doesn't support create() — write to GTiff first, then copy to PNG
    const gtiffDriver = gdal.drivers.get('GTiff');
    const tmpFile     = outFile.replace('.png', '_tmp.tif');

    const tmpDs = gtiffDriver.create(tmpFile, xSize, ySize, 1, gdal.GDT_Byte);
    await tmpDs.bands.get(1).pixels.writeAsync(0, 0, xSize, ySize, Buffer.from(out));
    tmpDs.geoTransform = [
      minLon, (maxLon - minLon) / xSize, 0,
      maxLat, 0, -(maxLat - minLat) / ySize,
    ];
    tmpDs.srs = demDs.srs;
    tmpDs.flush();

    // Copy GTiff → PNG
    const pngDriver = gdal.drivers.get('PNG');
    const outDs     = pngDriver.createCopy(outFile, tmpDs);
    outDs.close();
    tmpDs.close();
    demDs.close();

    // Remove the temp GTiff
    require('fs').unlinkSync(tmpFile);

    job.progress = 100;
    job.status   = 'done';
    job.fileName = `ShadedRelief_${jobId}.png`;
    job.extent   = [minLon, minLat, maxLon, maxLat];

  } catch (err) {
    job.status = 'failed';
    job.error  = err.message;
    console.error(`GDAL job ${jobId} failed:`, err.message);
  }
}

// ── POST /api/terrain/execute ─────────────────────────────
router.post('/execute', (req, res) => {
  let { aoi, azimuthAngle, verticalAngle } = req.body;

  // Accept aoi as "leftLon,topLat,rightLon,bottomLat" string
  if (typeof aoi === 'string') {
    const p = aoi.split(',').map(Number);
    aoi = [
      Math.min(p[0], p[2]), Math.min(p[1], p[3]),
      Math.max(p[0], p[2]), Math.max(p[1], p[3]),
    ];
  }

  const jobId    = newJobId();
  jobs[jobId]    = { status: 'running', progress: 0 };

  runHillshade(jobId, aoi, Number(azimuthAngle) || 315, Number(verticalAngle) || 45);

  res.json({ jobId });
});

// ── GET /api/terrain/status/:jobId ────────────────────────
router.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress });
});

// ── GET /api/terrain/output/:jobId ────────────────────────
router.get('/output/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(202).json({ status: job.status });
  res.json({ fileName: job.fileName, extent: job.extent });
});

module.exports = router;
