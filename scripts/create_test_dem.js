'use strict';
/**
 * Creates a synthetic DEM GeoTIFF for testing GDAL hillshade.
 * Covers India roughly: lon 68–97, lat 8–37
 *
 * Run once: node scripts/create_test_dem.js
 */
const gdal = require('gdal-async');
const path = require('path');
const fs   = require('fs');

const OUT_FILE = path.join(__dirname, '../data/dem.tif');
const DIR      = path.dirname(OUT_FILE);

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

// Grid size — larger = more detail but slower
const WIDTH  = 512;
const HEIGHT = 512;

// Bounding box (India)
const MIN_LON = 68.0;
const MAX_LON = 97.0;
const MIN_LAT =  8.0;
const MAX_LAT = 37.0;

async function create() {
  const driver = gdal.drivers.get('GTiff');
  const ds     = driver.create(OUT_FILE, WIDTH, HEIGHT, 1, gdal.GDT_Float32);

  // Set geo-transform: [originX, pixelWidth, 0, originY, 0, pixelHeight]
  ds.geoTransform = [
    MIN_LON,
    (MAX_LON - MIN_LON) / WIDTH,
    0,
    MAX_LAT,
    0,
    -(MAX_LAT - MIN_LAT) / HEIGHT,
  ];

  // Set WGS84 projection
  ds.srs = gdal.SpatialReference.fromEPSG(4326);

  // Generate synthetic elevation: hills, plains, and a ridge
  const band = ds.bands.get(1);
  const data = new Float32Array(WIDTH * HEIGHT);

  for (let r = 0; r < HEIGHT; r++) {
    for (let c = 0; c < WIDTH; c++) {
      const x = c / WIDTH;   // 0..1 (west→east)
      const y = r / HEIGHT;  // 0..1 (north→south)

      // Himalayan ridge in the north (y near 0)
      const himalaya = Math.exp(-y * 8) * 8000;

      // Deccan plateau in the south-centre
      const plateau  = Math.max(0, 600 - Math.abs(x - 0.5) * 3000 - y * 400);

      // Random terrain noise
      const noise = Math.sin(x * 40) * Math.cos(y * 30) * 300
                  + Math.sin(x * 15 + 1) * Math.sin(y * 20) * 150;

      data[r * WIDTH + c] = Math.max(0, himalaya + plateau + noise);
    }
  }

  await band.pixels.writeAsync(0, 0, WIDTH, HEIGHT, Buffer.from(data.buffer));
  band.noDataValue = -9999;

  ds.flush();
  ds.close();
  console.log(`✅  Synthetic DEM created: ${OUT_FILE}`);
  console.log(`    Size: ${WIDTH}×${HEIGHT}, Extent: [${MIN_LON}, ${MIN_LAT}, ${MAX_LON}, ${MAX_LAT}]`);
}

create().catch(err => {
  console.error('Failed to create DEM:', err.message);
  process.exit(1);
});
