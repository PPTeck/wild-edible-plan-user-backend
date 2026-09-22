const pool = require("../db");
const fs = require("fs");

const createFieldUserPlant = async (req, res) => {

    try {

        // =====================================================
        // GET PLANT DETAILS
        // =====================================================

        const {
            scientific_name,
            common_name,
            family,
            habitat,
            distribution,
            edible_parts,
            nutritional_value,
            flowering_season,
            conservation_status,
            latitude,
            longitude
        } = req.body;


        // =====================================================
        // IMAGE VALIDATION
        // =====================================================

        if (!req.file) {

            return res.status(400).json({
                success: false,
                message: "Plant image is required"
            });

        }


        // =====================================================
        // REQUIRED FIELD VALIDATION
        // =====================================================

        if (!scientific_name) {

            return res.status(400).json({
                success: false,
                message: "Scientific name is required"
            });

        }

        if (!common_name) {

            return res.status(400).json({
                success: false,
                message: "Common name is required"
            });

        }

        if (!family) {

            return res.status(400).json({
                success: false,
                message: "Family is required"
            });

        }

        if (!habitat) {

            return res.status(400).json({
                success: false,
                message: "Habitat is required"
            });

        }

        if (!distribution) {

            return res.status(400).json({
                success: false,
                message: "Distribution is required"
            });

        }

        if (!edible_parts) {

            return res.status(400).json({
                success: false,
                message: "Edible parts are required"
            });

        }

        if (!latitude || !longitude) {

            return res.status(400).json({
                success: false,
                message: "Latitude and longitude are required"
            });

        }


        // =====================================================
        // USER ID FROM JWT
        // =====================================================

        const uploadedBy = req.user.id;


        // =====================================================
        // IMAGE PATH
        // =====================================================

        const imageUrl =
            `/uploads/plant-requests/${req.file.filename}`;


        // =====================================================
        // PLANT DATA
        // =====================================================

        const plantData = {

            scientific_name,
            common_name,
            family,
            habitat,
            distribution,
            edible_parts,
            nutritional_value: nutritional_value || null,
            flowering_season: flowering_season || null,
            conservation_status: conservation_status || null,

            image_url: imageUrl,
            image_mime_type: req.file.mimetype,
            latitude: Number(latitude),
            longitude: Number(longitude),

            uploaded_by: uploadedBy

        };


        // =====================================================
        // REQUEST NUMBER
        // =====================================================

        const requestNumber =
            "PLANT-" + Date.now();


        // =====================================================
        // INSERT APPROVAL REQUEST
        // =====================================================

        const result = await pool.query(
            `
            INSERT INTO approval_requests
            (
                request_number,
                status,
                current_approval_level,
                request_data
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4
            )
            RETURNING *
            `,
            [
                requestNumber,
                "PENDING_REVIEWER",
                1,
                JSON.stringify(plantData)
            ]
        );


        // =====================================================
        // SUCCESS
        // =====================================================

        return res.status(201).json({

            success: true,

            message:
                "Plant submitted successfully and sent for reviewer approval",

            request: result.rows[0]

        });


    } catch (error) {

        console.error(
            "FIELD USER PLANT SUBMISSION ERROR:",
            error
        );


        // Delete uploaded image if DB insertion failed

        if (req.file) {

            fs.unlink(
                req.file.path,
                (unlinkError) => {

                    if (unlinkError) {

                        console.error(
                            "Failed to delete uploaded image:",
                            unlinkError
                        );

                    }

                }
            );

        }


        return res.status(500).json({

            success: false,

            message:
                "Failed to submit plant"

        });

    }

};

//get plant details for  field user

const getFieldUserPlants = async (req, res) => {

    try {

        const userId = req.user.id;

        const result = await pool.query(
            `
            SELECT
                id,
                request_number,
                status,
                current_approval_level,
                request_data
            FROM approval_requests
            WHERE request_data->>'uploaded_by' = $1
            ORDER BY id DESC
            `,
            [String(userId)]
        );

        const plants = result.rows.map(row => {

            const data = row.request_data;

            return {
                id: row.id,
                request_number: row.request_number,
                status: row.status,
                current_approval_level: row.current_approval_level,

                scientific_name: data.scientific_name,
                common_name: data.common_name,
                family: data.family,
                habitat: data.habitat,
                distribution: data.distribution,
                edible_parts: data.edible_parts,
                nutritional_value: data.nutritional_value,
                flowering_season: data.flowering_season,
                conservation_status: data.conservation_status,

                image_url: data.image_url,
                image_mime_type: data.image_mime_type,

                latitude: data.latitude,
                longitude: data.longitude,

                uploaded_by: data.uploaded_by
            };

        });

        return res.status(200).json({
            success: true,
            count: plants.length,
            plants: plants
        });

    } catch (error) {

        console.error(
            "GET FIELD USER PLANTS ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch submitted plants"
        });

    }
};


const getFieldUserPlantById = async (req, res) => {

    try {

        const { id } = req.params;
        const userId = req.user.id;

        const result = await pool.query(
            `
            SELECT
                id,
                request_number,
                status,
                current_approval_level,
                request_data
            FROM approval_requests
            WHERE id = $1
            AND request_data->>'uploaded_by' = $2
            `,
            [id, String(userId)]
        );

        if (result.rows.length === 0) {

            return res.status(404).json({
                success: false,
                message: "Plant submission not found"
            });

        }

        const row = result.rows[0];
        const data = row.request_data;

        return res.status(200).json({

            success: true,

            plant: {
                id: row.id,
                request_number: row.request_number,
                status: row.status,
                current_approval_level:
                    row.current_approval_level,

                scientific_name: data.scientific_name,
                common_name: data.common_name,
                family: data.family,
                habitat: data.habitat,
                distribution: data.distribution,
                edible_parts: data.edible_parts,
                nutritional_value: data.nutritional_value,
                flowering_season: data.flowering_season,
                conservation_status: data.conservation_status,

                image_url: data.image_url,
                image_mime_type: data.image_mime_type,

                latitude: data.latitude,
                longitude: data.longitude,

                uploaded_by: data.uploaded_by
            }

        });

    } catch (error) {

        console.error(
            "GET FIELD USER PLANT BY ID ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch plant submission"
        });

    }
};

const searchFieldUserPlantsByScientificName = async (req, res) => {

    try {

        const { scientific_name } = req.query;
        const userId = req.user.id;

        if (!scientific_name) {
            return res.status(400).json({
                success: false,
                message: "scientific_name is required"
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                request_number,
                status,
                current_approval_level,
                request_data
            FROM approval_requests
            WHERE request_data->>'uploaded_by' = $1
            AND LOWER(request_data->>'scientific_name')
                = LOWER($2)
            ORDER BY id DESC
            `,
            [String(userId), scientific_name]
        );

        const plants = result.rows.map(row => {

            const data = row.request_data;

            return {
                id: row.id,
                request_number: row.request_number,
                status: row.status,
                current_approval_level:
                    row.current_approval_level,

                scientific_name: data.scientific_name,
                common_name: data.common_name,
                family: data.family,
                habitat: data.habitat,
                distribution: data.distribution,
                edible_parts: data.edible_parts,
                nutritional_value: data.nutritional_value,
                flowering_season: data.flowering_season,
                conservation_status: data.conservation_status,

                image_url: data.image_url,
                image_mime_type: data.image_mime_type,

                latitude: data.latitude,
                longitude: data.longitude,

                uploaded_by: data.uploaded_by
            };

        });

        return res.status(200).json({
            success: true,
            count: plants.length,
            plants: plants
        });

    } catch (error) {

        console.error(
            "SEARCH PLANTS BY SCIENTIFIC NAME ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to search plants"
        });

    }

};
// ============================================================
// FIELD USER - SEARCH BY COMMON NAME
// ============================================================
// ============================================================
// FIELD USER - SEARCH PLANT BY COMMON NAME
// ============================================================

const searchFieldUserPlantsByCommonName = async (req, res) => {
    try {

        const { common_name } = req.query;

        // Validate common name
        if (!common_name || !common_name.trim()) {
            return res.status(400).json({
                success: false,
                message: "common_name is required"
            });
        }

        const result = await pool.query(
            `
            SELECT
                plant_id,
                image_id,
                scientific_name,
                common_name,
                family,
                habitat,
                distribution,
                edible_parts,
                nutritional_value,
                flowering_season,
                conservation_status,
                image_url,
                latitude,
                longitude,
                uploaded_by,
                verified_status,
                created_date,
                image_mime_type
            FROM plant_table
            WHERE LOWER(common_name) = LOWER($1)
            AND verified_status = true
            AND deleted_at IS NULL
            ORDER BY plant_id DESC
            `,
            [common_name.trim()]
        );

        return res.status(200).json({
            success: true,
            count: result.rows.length,
            plants: result.rows
        });

    } catch (error) {

        console.error(
            "SEARCH PLANTS BY COMMON NAME ERROR:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to search plants"
        });
    }
};
module.exports = {
    createFieldUserPlant,
    getFieldUserPlants,
    getFieldUserPlantById,
    searchFieldUserPlantsByScientificName,
    searchFieldUserPlantsByCommonName
};