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
    searchFieldUserPlantsByCommonName
} = require("../controllers/fielduserplantcontroller");


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


module.exports = router;