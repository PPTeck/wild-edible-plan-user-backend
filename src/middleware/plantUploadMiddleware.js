const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ============================================================
// PLANT IMAGE UPLOAD DIRECTORY
// ============================================================

const uploadDirectory = path.join(
    __dirname,
    "..",
    "uploads",
    "plants"
);

// Create directory if it doesn't exist
if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(uploadDirectory, {
        recursive: true
    });
}

// ============================================================
// MULTER STORAGE
// ============================================================

const storage = multer.diskStorage({

    destination: (req, file, cb) => {
        cb(null, uploadDirectory);
    },

    filename: (req, file, cb) => {

        const extension =
            path.extname(file.originalname).toLowerCase();

        const uniqueName =
            `${Date.now()}-${Math.round(Math.random() * 1E9)}${extension}`;

        cb(null, uniqueName);
    }
});

// ============================================================
// IMAGE / BIN VALIDATION
// ============================================================

const fileFilter = (req, file, cb) => {

    const allowedMimeTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
        "application/octet-stream"
    ];

    const allowedExtensions = [
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".bin"
    ];

    const extension =
        path.extname(file.originalname).toLowerCase();

    if (
        allowedMimeTypes.includes(file.mimetype) &&
        allowedExtensions.includes(extension)
    ) {
        cb(null, true);
    } else {

        cb(
            new Error(
                "Only JPG, JPEG, PNG, WEBP and BIN files are allowed"
            ),
            false
        );

    }
};

// ============================================================
// MULTER CONFIGURATION
// ============================================================

const upload = multer({

    storage: storage,

    fileFilter: fileFilter,

    limits: {
        files: 1,
        fileSize: 5 * 1024 * 1024
    }

});

module.exports = upload;