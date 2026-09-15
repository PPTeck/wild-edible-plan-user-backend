const jwt  = require("jsonwebtoken");
const pool = require("../db");

const authenticateToken = async (req, res, next) => {

    try {

        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return res.status(401).json({
                message: "Authorization header is required"
            });
        }

        // Expected format: Authorization: Bearer TOKEN

        const parts = authHeader.split(" ");

        if (parts.length !== 2 || parts[0] !== "Bearer") {
            return res.status(401).json({
                message: "Invalid authorization format"
            });
        }

        const token = parts[1];

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        // --------------------------------------------------------
        // VALIDATE SESSION IS STILL ACTIVE IN user_sessions TABLE
        // --------------------------------------------------------

        if (decoded.session_id) {

            const sessionResult = await pool.query(
                `SELECT is_active
                 FROM   user_sessions
                 WHERE  session_id = $1`,
                [decoded.session_id]
            );

            if (
                sessionResult.rows.length === 0 ||
                sessionResult.rows[0].is_active === false
            ) {
                return res.status(401).json({
                    message: "Session has been invalidated. Please log in again."
                });
            }

            // Keep last_activity fresh
            await pool.query(
                `UPDATE user_sessions
                 SET    last_activity = CURRENT_TIMESTAMP
                 WHERE  session_id = $1`,
                [decoded.session_id]
            );

        }

        // Store logged-in user on request
        req.user = decoded;

        next();

    } catch (error) {

        console.error("Authentication error:", error.message);

        return res.status(401).json({
            message: "Invalid or expired token"
        });

    }

};

module.exports = authenticateToken;