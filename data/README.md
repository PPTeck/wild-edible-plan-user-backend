# DEM Data

Place your DEM GeoTIFF here as `dem.tif`.

## Quick options:

### Option 1 — Generate synthetic test DEM (no download needed):
```bash
cd node-backend
node scripts/create_test_dem.js
```

### Option 2 — Download real SRTM data for India:
```bash
pip install elevation
eio clip -o data/dem.tif --bounds 68 8 97 37
```

### Option 3 — Set a custom path via .env:
```
DEM_FILE=C:/path/to/your/dem.tif
```
