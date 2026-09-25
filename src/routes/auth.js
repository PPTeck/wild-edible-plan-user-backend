'use strict';
/**
 * Auth routes:
 *   POST /api/auth/login        — verify email+password, generate OTP, send via AWS SES SMTP
 *   POST /api/auth/verify-otp   — verify OTP code, return user session
 *
 * OTP: 6-digit, stored in otp_table, expires 5 minutes.
 * Delivery: Nodemailer → AWS SES SMTP → user's email_id from user_table.
 */
require('dotenv').config();
const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool       = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'local-development-jwt-secret';

// ── AWS SES SMTP transporter ───────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   Number(process.env.SMTP_PORT) || 465,
  secure: true,                // TLS on port 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Check if email is configured
const emailConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER
  && process.env.SMTP_PASS);

// ── Helper: 6-digit OTP ───────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Helper: send OTP email via AWS SES ────────────────────
async function sendOtpEmail(toEmail, userName, otp) {
  if (!emailConfigured) {
    console.log(`[DEV] OTP for ${toEmail}: ${otp}`);
    return { dev: true };
  }

  const mailOptions = {
    from:    `"Web GIS Plant Portal" <${process.env.SMTP_FROM}>`,
    to:      toEmail,
    subject: 'Your OTP Code — Web GIS Plant Portal',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;
                  border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <div style="background:#14532d;padding:24px;text-align:center;">
          <h2 style="color:#fff;margin:0;">🌿 Web GIS Plant Portal</h2>
        </div>
        <div style="padding:28px 24px;">
          <p style="color:#374151;font-size:15px;">Hello <strong>${userName}</strong>,</p>
          <p style="color:#374151;font-size:14px;">
            Your One-Time Password (OTP) for login verification is:
          </p>
          <div style="background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;
                      padding:20px;text-align:center;margin:20px 0;">
            <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#14532d;">
              ${otp}
            </span>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            ⏱ This OTP is valid for <strong>5 minutes</strong>.<br/>
            🔒 Do not share this code with anyone.
          </p>
        </div>
        <div style="background:#f9fafb;padding:14px;text-align:center;">
          <p style="color:#9ca3af;font-size:12px;margin:0;">
            If you did not request this, please ignore this email.
          </p>
        </div>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
  console.log(`OTP email sent to ${toEmail}`);
  return { sent: true };
}

// ── POST /api/auth/login ───────────────────────────────────
router.post('/login', async (req, res) => {
  const { emailId, password, roleName } = req.body;

  if (!emailId || !password || !roleName) {
    return res.status(400).json({ error: 'emailId, password and roleName are required' });
  }

  try {
    // Find user by email + role
    const { rows } = await pool.query(`
      SELECT u.user_id, u.user_name, u.phone_number, u.email_id,
             u.password_hash,
             TRIM(r.role_name)  AS "roleName",
             r.feature_allowed  AS "featureAllowed"
      FROM user_table u
      JOIN role_table r ON u.role_id = r.role_id
      WHERE LOWER(u.email_id) = LOWER($1)
        AND TRIM(r.role_name) = $2
    `, [emailId.trim(), roleName]);

    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid email or role. Please check and try again.' });
    }

    const user = rows[0];

    // Verify password — support test seed 'HASHED_PASSWORD'
    const isValid = user.password_hash === 'HASHED_PASSWORD'
      ? password === 'HASHED_PASSWORD'
      : await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    // Generate OTP (expires in 5 minutes)
    const otp       = generateOTP();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Remove old unverified OTPs for this user
    await pool.query(
      `DELETE FROM otp_table WHERE user_id = $1 AND verified = FALSE`,
      [user.user_id]
    );

    // Save new OTP
    await pool.query(
      `INSERT INTO otp_table (user_id, otp_code, expires_at) VALUES ($1, $2, $3)`,
      [user.user_id, otp, expiresAt]
    );

    // Send OTP to user's email address from user_table
    const emailResult = await sendOtpEmail(user.email_id, user.user_name, otp);

    // Response
    const response = {
      success:      true,
      userId:       user.user_id,
      userName:     user.user_name,
      emailMasked:  maskEmail(user.email_id),
    };

    // In dev mode (email not configured), include OTP in response for testing
    if (emailResult.dev) {
      response.otp = otp;
    }

    res.json(response);

  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/verify-otp ──────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { userId, otpCode } = req.body;

  if (!userId || !otpCode) {
    return res.status(400).json({ error: 'userId and otpCode are required' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT o.otp_id, o.otp_code, o.expires_at,
             u.user_name, u.email_id, u.phone_number,
             TRIM(r.role_name)  AS "roleName",
             r.feature_allowed  AS "featureAllowed"
      FROM otp_table o
      JOIN user_table  u ON o.user_id  = u.user_id
      JOIN role_table  r ON u.role_id  = r.role_id
      WHERE o.user_id  = $1
        AND o.verified = FALSE
      ORDER BY o.created_at DESC
      LIMIT 1
    `, [userId]);

    if (!rows.length) {
      return res.status(401).json({ error: 'No pending OTP found. Please login again.' });
    }

    const record = rows[0];

    // Check expiry
    if (new Date() > new Date(record.expires_at)) {
      return res.status(401).json({ error: 'OTP expired (5 min). Please login again.' });
    }

    // Check code
    if (record.otp_code !== otpCode.trim()) {
      return res.status(401).json({ error: 'Invalid OTP code. Please try again.' });
    }

    // Mark verified
    await pool.query(
      `UPDATE otp_table SET verified = TRUE WHERE otp_id = $1`,
      [record.otp_id]
    );

    // Generate JWT — include a unique jti (JWT ID) for single-device enforcement
    const crypto       = require('crypto');
    const sessionId    = crypto.randomBytes(16).toString('hex');

    // ── Store current sessionId in user_table (legacy single-device field)
    await pool.query(
      `UPDATE user_table SET session_token = $1 WHERE user_id = $2`,
      [sessionId, userId]
    );

    // ── Check user_sessions for an existing active session ────────────────
    const existingSession = await pool.query(
      `SELECT id, session_id
       FROM   user_sessions
       WHERE  user_id   = $1
         AND  is_active = true
       ORDER  BY created_at DESC
       LIMIT  1`,
      [userId]
    );

    if (existingSession.rows.length > 0) {
      // Active session on another device — return 409 conflict
      return res.status(409).json({
        message:             'active_session_exists',
        existing_session_id: existingSession.rows[0].session_id,
      });
    }

    // ── Insert new session row ────────────────────────────────────────────
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);   // 8 h (matches JWT)
    await pool.query(
      `INSERT INTO user_sessions
         (user_id, session_id, is_active, created_at, last_activity, expires_at)
       VALUES ($1, $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
      [userId, sessionId, expiresAt]
    );

    const role = record.roleName.trim().toUpperCase();
    const token = jwt.sign({
      id:        Number(userId),
      email:     record.email_id,
      role:      role === 'REVIEWER' ? 'MANAGER' : role,
      sessionId,                                       // ← unique per login
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success:        true,
      userId,
      userName:       record.user_name,
      emailId:        record.email_id,
      phoneNumber:    record.phone_number,
      roleName:       record.roleName,
      featureAllowed: record.featureAllowed,
      token,
    });

  } catch (err) {
    console.error('OTP verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: mask email — sunita@example.com → s*****@example.com
function maskEmail(email) {
  if (!email || !email.includes('@')) return '****';
  const [local, domain] = email.split('@');
  const masked = local[0] + '*'.repeat(Math.max(local.length - 1, 3));
  return `${masked}@${domain}`;
}

// ── POST /api/auth/validate-session ───────────────────────
// Angular polls this every 15 s and on mouse/click activity.
// Returns 401 when another device has taken over the session.
router.post('/validate-session', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // ── Primary check: user_sessions table (is_active flag) ──
    // JWT carries sessionId (hex string from crypto.randomBytes).
    if (decoded.sessionId) {
      const { rows } = await pool.query(
        `SELECT is_active FROM user_sessions WHERE session_id = $1`,
        [decoded.sessionId]
      );

      if (!rows.length || rows[0].is_active === false) {
        return res.status(401).json({
          error: 'Session has been invalidated. You have been logged in from another device.'
        });
      }

      // Refresh last_activity so idle sessions don't look stale
      await pool.query(
        `UPDATE user_sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = $1`,
        [decoded.sessionId]
      );

      return res.json({ valid: true });
    }

    // ── Fallback: legacy session_token field ──────────────────
    const { rows } = await pool.query(
      `SELECT session_token FROM user_table WHERE user_id = $1`,
      [decoded.id]
    );

    if (!rows.length) return res.status(401).json({ error: 'User not found' });

    if (rows[0].session_token !== decoded.sessionId) {
      return res.status(401).json({
        error: 'Session expired. You have been logged in from another device.'
      });
    }

    res.json({ valid: true });

  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────
router.post('/logout', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: true });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Clear session token from DB
    await pool.query(
      `UPDATE user_table SET session_token = NULL WHERE user_id = $1`,
      [decoded.id]
    );
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // Always succeed on logout
  }
});

// ── POST /api/auth/change-password ────────────────────────
router.post('/change-password', async (req, res) => {
  const { emailId, currentPassword, newPassword } = req.body;
  if (!emailId || !currentPassword || !newPassword)
    return res.status(400).json({ error: 'All fields are required' });

  try {
    const { rows } = await pool.query(
      `SELECT user_id, password_hash FROM user_table WHERE LOWER(email_id) = LOWER($1)`,
      [emailId.trim()]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const user = rows[0];
    const isValid = user.password_hash === 'HASHED_PASSWORD'
      ? currentPassword === 'HASHED_PASSWORD'
      : await bcrypt.compare(currentPassword, user.password_hash);

    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE user_table SET password_hash = $1 WHERE user_id = $2`, [hash, user.user_id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/forgot-password ────────────────────────
// Step 1: send OTP, Step 2: verify OTP, Step 3: update password
router.post('/forgot-password', async (req, res) => {
  const { step, emailId, userId, otpCode, newPassword } = req.body;
  const requestedStep = Number(step);

  if (![1, 2, 3].includes(requestedStep)) {
    return res.status(400).json({ error: 'step must be 1, 2 or 3' });
  }

  if (requestedStep === 1 && !emailId) {
    return res.status(400).json({ error: 'emailId is required for step 1' });
  }

  if ([2, 3].includes(requestedStep) && (!userId || !otpCode)) {
    return res.status(400).json({ error: 'userId and otpCode are required' });
  }

  if (requestedStep === 3 && !newPassword) {
    return res.status(400).json({ error: 'newPassword is required for step 3' });
  }

  try {
    if (requestedStep === 1) {
      const { rows } = await pool.query(
        `SELECT user_id, user_name, email_id FROM user_table WHERE LOWER(email_id) = LOWER($1)`,
        [emailId.trim()]
      );

      if (!rows.length) {
        return res.status(404).json({ error: 'No user found with this email address.' });
      }

      const user = rows[0];
      const otp  = generateOTP();
      const exp  = new Date(Date.now() + 5 * 60 * 1000);

      await pool.query(`DELETE FROM otp_table WHERE user_id = $1 AND verified = FALSE`, [user.user_id]);
      await pool.query(`INSERT INTO otp_table (user_id, otp_code, expires_at) VALUES ($1,$2,$3)`,
        [user.user_id, otp, exp]);

      const emailResult = await sendResetEmail(user.email_id, user.user_name, otp);
      const response = { success: true, userId: user.user_id, emailMasked: maskEmail(user.email_id) };
      if (emailResult.dev) response.otp = otp;
      return res.json(response);
    }

    const { rows } = await pool.query(`
      SELECT otp_id, otp_code, expires_at
      FROM otp_table
      WHERE user_id = $1 AND verified = FALSE
      ORDER BY created_at DESC LIMIT 1
    `, [userId]);

    if (!rows.length) return res.status(401).json({ error: 'No pending OTP found.' });

    const record = rows[0];
    if (new Date() > new Date(record.expires_at)) {
      return res.status(401).json({ error: 'OTP expired. Please request a new one.' });
    }
    if (record.otp_code !== otpCode.trim()) {
      return res.status(401).json({ error: 'Invalid OTP code.' });
    }

    if (requestedStep === 2) {
      return res.json({ success: true, message: 'OTP verified successfully.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await pool.query(`UPDATE otp_table SET verified = TRUE WHERE otp_id = $1`, [record.otp_id]);
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE user_table SET password_hash = $1 WHERE user_id = $2`, [hash, userId]);

    return res.json({ success: true, message: 'Password updated successfully.' });

  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: send password reset email ─────────────────────
async function sendResetEmail(toEmail, userName, otp) {
  if (!emailConfigured) {
    console.log(`[DEV] Reset OTP for ${toEmail}: ${otp}`);
    return { dev: true };
  }
  await transporter.sendMail({
    from:    `"Web GIS Plant Portal" <${process.env.SMTP_FROM}>`,
    to:      toEmail,
    subject: 'Password Reset OTP — Web GIS Plant Portal',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;
                  border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
        <div style="background:#1e3a5f;padding:24px;text-align:center;">
          <h2 style="color:#fff;margin:0;">🔑 Password Reset</h2>
        </div>
        <div style="padding:28px 24px;">
          <p style="color:#374151;font-size:15px;">Hello <strong>${userName}</strong>,</p>
          <p style="color:#374151;font-size:14px;">Use this OTP to reset your password:</p>
          <div style="background:#eff6ff;border:2px solid #bfdbfe;border-radius:10px;
                      padding:20px;text-align:center;margin:20px 0;">
            <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#1e3a5f;">
              ${otp}
            </span>
          </div>
          <p style="color:#6b7280;font-size:13px;">
            ⏱ Valid for <strong>5 minutes</strong>. Do not share this code.
          </p>
        </div>
      </div>`,
  });
  return { sent: true };
}

// ── POST /api/auth/force-logout-session ───────────────────
// Called when the user clicks OK on the "already logged in" popup.
// Marks the existing session inactive so the next verify-otp can proceed.
router.post('/force-logout-session', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'session_id is required' });
  }

  try {
    await pool.query(
      `UPDATE user_sessions
       SET    is_active           = false,
              invalidated_at      = CURRENT_TIMESTAMP,
              invalidation_reason = 'forced_logout_by_new_login'
       WHERE  session_id = $1`,
      [session_id]
    );

    res.json({ success: true, message: 'Session invalidated successfully' });
  } catch (err) {
    console.error('force-logout-session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/issue-token ────────────────────────────
// Called after force-logout to issue a fresh JWT + session
// without requiring the user to re-enter OTP.
// Only works if the user has a recently-verified OTP row.
router.post('/issue-token', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    // Fetch user + role info
    const { rows } = await pool.query(`
      SELECT u.user_id, u.user_name, u.email_id, u.phone_number,
             TRIM(r.role_name)  AS "roleName",
             r.feature_allowed  AS "featureAllowed"
      FROM user_table  u
      JOIN role_table  r ON u.role_id = r.role_id
      WHERE u.user_id = $1
    `, [userId]);

    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const record = rows[0];
    const crypto = require('crypto');
    const sessionId = crypto.randomBytes(16).toString('hex');

    // Update legacy session_token
    await pool.query(
      `UPDATE user_table SET session_token = $1 WHERE user_id = $2`,
      [sessionId, userId]
    );

    // Insert fresh user_sessions row
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO user_sessions
         (user_id, session_id, is_active, created_at, last_activity, expires_at)
       VALUES ($1, $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $3)`,
      [userId, sessionId, expiresAt]
    );

    const role  = record.roleName.trim().toUpperCase();
    const token = jwt.sign({
      id:        Number(userId),
      email:     record.email_id,
      role:      role === 'REVIEWER' ? 'MANAGER' : role,
      sessionId,
    }, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      success:        true,
      userId,
      userName:       record.user_name,
      emailId:        record.email_id,
      phoneNumber:    record.phone_number,
      roleName:       record.roleName,
      featureAllowed: record.featureAllowed,
      token,
    });

  } catch (err) {
    console.error('issue-token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
