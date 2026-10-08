const express = require("express");

const router = express.Router();

const authenticateToken =
    require("../middleware/authMiddleware");

const upload =
    require("../middleware/plantRequestUploadMiddleware");

const {
    createFieldUserPlant,
    getFieldUserPlantById,
    searchFieldUserPlantsByScientificName,
    searchFieldUserPlantsByCommonName,
    getApprovedPlantsInArea,
    getAllPlants
} = require("../controllers/fielduserplantcontroller");


// ============================================================
// FIELD USER - GET FULL PLANT LIST
// ============================================================

router.get(
    "/plants/all",
    authenticateToken,
    getAllPlants
);

// ============================================================
// FIELD USER - SUBMIT PLANT
// ============================================================

router.post(
    "/plants",
    authenticateToken,
    upload.single("photo"),
    createFieldUserPlant
);


// ============================================================
// FIELD USER - SEARCH BY SCIENTIFIC NAME
// ============================================================

router.get(
    "/plants",
    authenticateToken,
    searchFieldUserPlantsByScientificName
);


// ============================================================
// FIELD USER - SEARCH BY COMMON NAME
// ============================================================

router.get(
    "/plants/common-name",
    authenticateToken,
    searchFieldUserPlantsByCommonName
);


// ============================================================
// FIELD USER - GET PLANT BY ID
// ============================================================

router.get(
    "/plants/:id",
    authenticateToken,
    getFieldUserPlantById
);

router.get(
    "/approved-plants-in-area",
    authenticateToken,
    getApprovedPlantsInArea
);


module.exports = router;