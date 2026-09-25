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

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const pool = require('../db');

const JWT_SECRET =
  process.env.JWT_SECRET || 'local-development-jwt-secret';

const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_HOURS = 1;
const LOCKOUT_WINDOW = `${LOCKOUT_HOURS} hours`;


/* ================================================================
   AWS SES SMTP TRANSPORTER
================================================================ */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});


/* ================================================================
   EMAIL CONFIGURATION CHECK
================================================================ */

const emailConfigured = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
);


/* ================================================================
   HELPER: GENERATE OTP
================================================================ */

function generateOTP() {
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}


/* ================================================================
   HELPER: DETECT DEVICE TYPE + IP ADDRESS
================================================================ */

function getDeviceInfo(req) {

  const userAgent =
    String(
      req.headers['user-agent'] || ''
    ).toLowerCase();

  let deviceType = 'Browser';


  // TV
  if (
    /smart[- ]?tv|tizen|webos|netcast|hbbtv/.test(userAgent)
  ) {

    deviceType = 'TV';

  }

  // Tablet
  else if (
    /ipad|tablet|android(?!.*mobile)/.test(userAgent)
  ) {

    deviceType = 'Tablet';

  }

  // Mobile
  else if (
    /iphone|ipod|android.*mobile|windows phone|mobile/.test(userAgent)
  ) {

    deviceType = 'Mobile';

  }

  // Laptop / Desktop
  else if (
    /windows|macintosh|linux|cros/.test(userAgent)
  ) {

    deviceType = 'Laptop';

  }

  // Browser / Unknown
  else {

    deviceType = 'Browser';

  }


  /* --------------------------------------------------------------
     GET CLIENT IP
  -------------------------------------------------------------- */

  const forwardedFor =
    req.headers['x-forwarded-for'];

  let ipAddress = '';


  if (
    typeof forwardedFor === 'string'
  ) {

    ipAddress =
      forwardedFor
        .split(',')[0]
        .trim();

  }

  else if (
    Array.isArray(forwardedFor)
  ) {

    ipAddress =
      String(
        forwardedFor[0] || ''
      ).trim();

  }

  else {

    ipAddress =
      req.ip ||
      req.socket?.remoteAddress ||
      '';

  }


  // Remove IPv4-mapped IPv6 prefix
  ipAddress =
    String(ipAddress)
      .replace(/^::ffff:/, '');


  return {

    deviceType,

    ipAddress,

    // Browser request does not provide reliable geographic location.
    // Keep this NULL until a real location source is implemented.
    location: null

  };

}


/* ================================================================
   HELPER: SEND OTP EMAIL
================================================================ */

async function sendOtpEmail(
  toEmail,
  userName,
  otp
) {

  if (!emailConfigured) {

    console.log(
      `[DEV] OTP for ${toEmail}: ${otp}`
    );

    return {
      dev: true
    };

  }


  const mailOptions = {

    from:
      `"Web GIS Plant Portal" <${process.env.SMTP_FROM}>`,

    to:
      toEmail,

    subject:
      'Your OTP Code — Web GIS Plant Portal',

    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;
                  border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

        <div style="background:#14532d;padding:24px;text-align:center;">
          <h2 style="color:#fff;margin:0;">
            🌿 Web GIS Plant Portal
          </h2>
        </div>

        <div style="padding:28px 24px;">

          <p style="color:#374151;font-size:15px;">
            Hello <strong>${userName}</strong>,
          </p>

          <p style="color:#374151;font-size:14px;">
            Your One-Time Password (OTP) for login verification is:
          </p>

          <div style="background:#f0fdf4;border:2px solid #bbf7d0;
                      border-radius:10px;padding:20px;text-align:center;
                      margin:20px 0;">

            <span style="font-size:36px;font-weight:900;
                         letter-spacing:12px;color:#14532d;">
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
    `

  };


  await transporter.sendMail(
    mailOptions
  );

  console.log(
    `OTP email sent to ${toEmail}`
  );

  return {
    sent: true
  };

}


/* ================================================================
   POST /api/auth/login
================================================================ */

router.post(
  '/login',
  async (req, res) => {

    const {
      emailId,
      password,
      roleName
    } = req.body;


    if (
      !emailId ||
      !password ||
      !roleName
    ) {

      return res.status(400).json({
        error:
          'emailId, password and roleName are required'
      });

    }


    try {

      const normalizedEmail =
        emailId
          .trim()
          .toLowerCase();

      const isAdminLogin =
        roleName
          .trim()
          .toLowerCase() === 'admin';

      if (!isAdminLogin) {
        const blockedResult = await pool.query(
          `SELECT user_id
           FROM blocked_users
           WHERE LOWER(email_id) = LOWER($1)
           LIMIT 1`,
          [normalizedEmail]
        );

        if (blockedResult.rows.length > 0) {
          return res.status(403).json({
            error: 'account_blocked'
          });
        }
      }


      /* ------------------------------------------------------------
         LOGIN ATTEMPT LOCKOUT
      ------------------------------------------------------------ */

      const attemptsResult =
        !isAdminLogin &&
        await pool.query(
          `
          SELECT COUNT(*) AS count
          FROM login_attempts
          WHERE email = $1
            AND success = FALSE
            AND attempted_at > NOW() - $2::INTERVAL
          `,
          [
            normalizedEmail,
            LOCKOUT_WINDOW
          ]
        );


      if (
        !isAdminLogin &&
        Number(
          attemptsResult.rows[0].count
        ) >= MAX_LOGIN_ATTEMPTS
      ) {

        const oldestResult =
          await pool.query(
            `
            SELECT attempted_at
            FROM login_attempts
            WHERE email = $1
              AND success = FALSE
              AND attempted_at > NOW() - $2::INTERVAL
            ORDER BY attempted_at ASC
            LIMIT 1
            `,
            [
              normalizedEmail,
              LOCKOUT_WINDOW
            ]
          );


        const lockedSince =
          new Date(
            oldestResult
              .rows[0]
              .attempted_at
          );


        const lockedUntil =
          new Date(
            lockedSince.getTime() +
            LOCKOUT_HOURS * 60 * 60 * 1000
          );


        const lockedUserResult =
          await pool.query(
            `
            SELECT user_name
            FROM user_table u
            JOIN role_table r
              ON u.role_id = r.role_id
            WHERE LOWER(u.email_id) = $1
              AND TRIM(r.role_name) = $2
            LIMIT 1
            `,
            [
              normalizedEmail,
              roleName
            ]
          );


        return res.status(429).json({

          error:
            'account_locked',

          userName:
            lockedUserResult.rows[0]
              ?.user_name ??
            normalizedEmail,

          lockedUntil:
            lockedUntil.toISOString(),

          minutesLeft:
            Math.max(
              1,
              Math.ceil(
                (
                  lockedUntil.getTime() -
                  Date.now()
                ) / 60000
              )
            )

        });

      }


      /* ------------------------------------------------------------
         FIND USER
      ------------------------------------------------------------ */

      const {
        rows
      } = await pool.query(
        `
        SELECT
          u.user_id,
          u.user_name,
          u.phone_number,
          u.email_id,
          u.password_hash,
          u.is_active,
          TRIM(r.role_name) AS "roleName",
          r.feature_allowed AS "featureAllowed"

        FROM user_table u

        JOIN role_table r
          ON u.role_id = r.role_id

        WHERE LOWER(u.email_id) = LOWER($1)
          AND TRIM(r.role_name) = $2
        `,
        [
          normalizedEmail,
          roleName
        ]
      );


      if (!rows.length) {

        if (!isAdminLogin) {

          await pool.query(
            `
            INSERT INTO login_attempts
              (email, success, ip_address)
            VALUES
              ($1, FALSE, $2)
            `,
            [
              normalizedEmail,
              req.ip ?? null
            ]
          );

        }


        return res.status(401).json({
          error:
            'Invalid email or role. Please check and try again.'
        });

      }


      const user = rows[0];


      /* ------------------------------------------------------------
         CHECK ACCOUNT STATUS
      ------------------------------------------------------------ */

      if (user.is_active !== true) {

        return res.status(403).json({
          error: 'account_deactivated',
          message:
            'Your account has been deactivated. You cannot log in at this time. Please contact the administrator.'
        });

      }


      /* ------------------------------------------------------------
         VERIFY PASSWORD
      ------------------------------------------------------------ */

      const isValid =
        user.password_hash === 'HASHED_PASSWORD'

          ? password === 'HASHED_PASSWORD'

          : await bcrypt.compare(
              password,
              user.password_hash
            );


      if (!isValid) {

        if (!isAdminLogin) {

          await pool.query(
            `
            INSERT INTO login_attempts
              (email, success, ip_address)
            VALUES
              ($1, FALSE, $2)
            `,
            [
              normalizedEmail,
              req.ip ?? null
            ]
          );

        }


        const failedAttempts =
          !isAdminLogin &&
          await pool.query(
            `
            SELECT COUNT(*) AS count
            FROM login_attempts
            WHERE email = $1
              AND success = FALSE
              AND attempted_at > NOW() - $2::INTERVAL
            `,
            [
              normalizedEmail,
              LOCKOUT_WINDOW
            ]
          );


        const attempts =
          !isAdminLogin &&
          Number(
            failedAttempts.rows[0].count
          );


        if (
          !isAdminLogin &&
          attempts >= MAX_LOGIN_ATTEMPTS
        ) {

          await pool.query(
            `INSERT INTO blocked_users
              (user_id, user_name, email_id, blocked_at)
             SELECT $1, $2, $3, CURRENT_TIMESTAMP
             WHERE NOT EXISTS (
               SELECT 1 FROM blocked_users WHERE user_id = $1
             )`,
            [
              user.user_id,
              user.user_name,
              user.email_id
            ]
          );

          const oldestResult =
            await pool.query(
              `
              SELECT attempted_at
              FROM login_attempts
              WHERE email = $1
                AND success = FALSE
                AND attempted_at > NOW() - $2::INTERVAL
              ORDER BY attempted_at ASC
              LIMIT 1
              `,
              [
                normalizedEmail,
                LOCKOUT_WINDOW
              ]
            );


          const lockedUntil =
            new Date(
              new Date(
                oldestResult
                  .rows[0]
                  .attempted_at
              ).getTime() +
              LOCKOUT_HOURS * 60 * 60 * 1000
            );


          return res.status(429).json({

            error:
              'account_locked',

            userName:
              user.user_name,

            lockedUntil:
              lockedUntil.toISOString(),

            minutesLeft:
              Math.max(
                1,
                Math.ceil(
                  (
                    lockedUntil.getTime() -
                    Date.now()
                  ) / 60000
                )
              )

          });

        }


        return res.status(401).json({
          error:
            'Incorrect password'
        });

      }


      /* ------------------------------------------------------------
         CLEAR FAILED LOGIN ATTEMPTS
      ------------------------------------------------------------ */

      if (!isAdminLogin) {

        await pool.query(
          `
          DELETE FROM login_attempts
          WHERE email = $1
            AND success = FALSE
          `,
          [
            normalizedEmail
          ]
        );

      }


      /* ------------------------------------------------------------
         GENERATE OTP
      ------------------------------------------------------------ */

      const otp =
        generateOTP();

      const expiresAt =
        new Date(
          Date.now() +
          5 * 60 * 1000
        );


      /* ------------------------------------------------------------
         REMOVE OLD UNVERIFIED OTP
      ------------------------------------------------------------ */

      await pool.query(
        `
        DELETE FROM otp_table
        WHERE user_id = $1
          AND verified = FALSE
        `,
        [
          user.user_id
        ]
      );


      /* ------------------------------------------------------------
         SAVE NEW OTP
      ------------------------------------------------------------ */

      await pool.query(
        `
        INSERT INTO otp_table
          (
            user_id,
            otp_code,
            expires_at
          )
        VALUES
          (
            $1,
            $2,
            $3
          )
        `,
        [
          user.user_id,
          otp,
          expiresAt
        ]
      );


      /* ------------------------------------------------------------
         SEND OTP
      ------------------------------------------------------------ */

      const emailResult =
        await sendOtpEmail(
          user.email_id,
          user.user_name,
          otp
        );


      /* ------------------------------------------------------------
         RESPONSE
      ------------------------------------------------------------ */

      const response = {

        success: true,

        userId:
          user.user_id,

        userName:
          user.user_name,

        emailMasked:
          maskEmail(
            user.email_id
          )

      };


      if (emailResult.dev) {

        response.otp = otp;

      }


      res.json(response);


    } catch (err) {

      console.error(
        'Login error:',
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   POST /api/auth/verify-otp
================================================================ */

router.post(
  '/verify-otp',
  async (req, res) => {

    const {
      userId,
      otpCode
    } = req.body;


    console.log(
      'verify-otp request:',
      {
        userId,
        otpCode
      }
    );


    if (
      !userId ||
      !otpCode
    ) {

      return res.status(400).json({
        error:
          'userId and otpCode are required'
      });

    }


    try {

      /* ------------------------------------------------------------
         FIND OTP + USER
      ------------------------------------------------------------ */

      const {
        rows
      } = await pool.query(
        `
        SELECT
          o.otp_id,
          o.otp_code,
          o.expires_at,

          u.user_name,
          u.email_id,
          u.phone_number,

          TRIM(r.role_name) AS "roleName",
          r.feature_allowed AS "featureAllowed"

        FROM otp_table o

        JOIN user_table u
          ON o.user_id = u.user_id

        JOIN role_table r
          ON u.role_id = r.role_id

        WHERE o.user_id = $1
          AND o.verified = FALSE

        ORDER BY o.created_at DESC

        LIMIT 1
        `,
        [
          userId
        ]
      );


      if (!rows.length) {

        return res.status(401).json({
          error:
            'No pending OTP found. Please login again.'
        });

      }


      const record =
        rows[0];


      /* ------------------------------------------------------------
         CHECK OTP EXPIRY
      ------------------------------------------------------------ */

      if (
        new Date() >
        new Date(
          record.expires_at
        )
      ) {

        return res.status(401).json({
          error:
            'OTP expired (5 min). Please login again.'
        });

      }


      /* ------------------------------------------------------------
         CHECK OTP CODE
      ------------------------------------------------------------ */

      if (
        record.otp_code !==
        otpCode.trim()
      ) {

        return res.status(401).json({
          error:
            'Invalid OTP code. Please try again.'
        });

      }


      /* ------------------------------------------------------------
         MARK OTP VERIFIED
      ------------------------------------------------------------ */

      await pool.query(
        `
        UPDATE otp_table
        SET verified = TRUE
        WHERE otp_id = $1
        `,
        [
          record.otp_id
        ]
      );


      /* ------------------------------------------------------------
         GENERATE UNIQUE SESSION ID
      ------------------------------------------------------------ */

      const sessionId =
        crypto
          .randomBytes(16)
          .toString('hex');


      /* ------------------------------------------------------------
         CHECK EXISTING ACTIVE SESSION
         
         IMPORTANT:
         This check happens BEFORE updating user_table.session_token.
      ------------------------------------------------------------ */

      const existingSession =
        await pool.query(
          `
          SELECT
            id,
            session_id

          FROM user_sessions

          WHERE user_id = $1
            AND is_active = TRUE

          ORDER BY created_at DESC

          LIMIT 1
          `,
          [
            userId
          ]
        );


      if (
        existingSession.rows.length > 0
      ) {

        console.log(
          'Active session already exists:',
          existingSession.rows[0].session_id
        );


        return res.status(409).json({

          message:
            'active_session_exists',

          existing_session_id:
            existingSession
              .rows[0]
              .session_id

        });

      }


      /* ------------------------------------------------------------
         UPDATE LEGACY SESSION TOKEN
      ------------------------------------------------------------ */

      await pool.query(
        `
        UPDATE user_table
        SET session_token = $1
        WHERE user_id = $2
        `,
        [
          sessionId,
          userId
        ]
      );


      /* ------------------------------------------------------------
         GET DEVICE INFORMATION
      ------------------------------------------------------------ */

      const {
        deviceType,
        ipAddress,
        location
      } = getDeviceInfo(req);


      console.log(
        'New login device information:',
        {
          deviceType,
          ipAddress,
          location
        }
      );


      /* ------------------------------------------------------------
         SESSION EXPIRY
         
         8 hours — same as JWT expiry.
      ------------------------------------------------------------ */

      const sessionExpiresAt =
        new Date(
          Date.now() +
          8 * 60 * 60 * 1000
        );


      /* ------------------------------------------------------------
         INSERT USER SESSION
      ------------------------------------------------------------ */

      await pool.query(
        `
        INSERT INTO user_sessions
        (
          user_id,
          session_id,
          is_active,
          created_at,
          last_activity,
          expires_at,
          device_type,
          location,
          ip_address
        )

        VALUES
        (
          $1,
          $2,
          TRUE,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          userId,
          sessionId,
          sessionExpiresAt,
          deviceType,
          location,
          ipAddress
        ]
      );


      /* ------------------------------------------------------------
         CREATE JWT
         
         IMPORTANT:
         Use session_id, NOT sessionId.
         
         authMiddleware reads:
         
             decoded.session_id
      ------------------------------------------------------------ */

      const role =
        record.roleName
          .trim()
          .toUpperCase();


      const token =
        jwt.sign(
          {
            id:
              Number(userId),

            email:
              record.email_id,

            role:
              role === 'REVIEWER'
                ? 'MANAGER'
                : role,

            session_id:
              sessionId

          },

          JWT_SECRET,

          {
            expiresIn: '8h'
          }
        );


      /* ------------------------------------------------------------
         RESPONSE
      ------------------------------------------------------------ */

      res.json({

        success: true,

        userId,

        userName:
          record.user_name,

        emailId:
          record.email_id,

        phoneNumber:
          record.phone_number,

        roleName:
          record.roleName,

        featureAllowed:
          record.featureAllowed,

        token

      });


    } catch (err) {

      console.error(
        'OTP verify error:',
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   HELPER: MASK EMAIL
================================================================ */

function maskEmail(email) {

  if (
    !email ||
    !email.includes('@')
  ) {

    return '****';

  }


  const [
    local,
    domain
  ] =
    email.split('@');


  const masked =
    local[0] +
    '*'.repeat(
      Math.max(
        local.length - 1,
        3
      )
    );


  return `${masked}@${domain}`;

}


/* ================================================================
   POST /api/auth/validate-session
================================================================ */

router.post(
  '/validate-session',
  async (req, res) => {

    const {
      token
    } = req.body;


    if (!token) {

      return res.status(400).json({
        error:
          'token required'
      });

    }


    try {

      const decoded =
        jwt.verify(
          token,
          JWT_SECRET
        );


      /* ------------------------------------------------------------
         PRIMARY CHECK:
         USER_SESSIONS TABLE
      ------------------------------------------------------------ */

      if (
        decoded.session_id
      ) {

        const {
          rows
        } = await pool.query(
          `
          SELECT
            is_active

          FROM user_sessions

          WHERE session_id = $1
          `,
          [
            decoded.session_id
          ]
        );


        if (
          !rows.length ||
          rows[0].is_active === false
        ) {

          return res.status(401).json({
            error:
              'Session has been invalidated. You have been logged in from another device.'
          });

        }


        /* ----------------------------------------------------------
           REFRESH LAST ACTIVITY
        ---------------------------------------------------------- */

        await pool.query(
          `
          UPDATE user_sessions
          SET last_activity = CURRENT_TIMESTAMP
          WHERE session_id = $1
          `,
          [
            decoded.session_id
          ]
        );


        return res.json({
          valid: true
        });

      }


      /* ------------------------------------------------------------
         LEGACY FALLBACK
      ------------------------------------------------------------ */

      const {
        rows
      } = await pool.query(
        `
        SELECT
          session_token

        FROM user_table

        WHERE user_id = $1
        `,
        [
          decoded.id
        ]
      );


      if (!rows.length) {

        return res.status(401).json({
          error:
            'User not found'
        });

      }


      if (
        rows[0].session_token !==
        decoded.session_id
      ) {

        return res.status(401).json({
          error:
            'Session expired. You have been logged in from another device.'
        });

      }


      res.json({
        valid: true
      });


    } catch (err) {

      res.status(401).json({
        error:
          'Invalid or expired token'
      });

    }

  }
);


/* ================================================================
   POST /api/auth/logout
================================================================ */

router.post(
  '/logout',
  async (req, res) => {

    const {
      token
    } = req.body;


    if (!token) {

      return res.json({
        success: true
      });

    }


    try {

      const decoded =
        jwt.verify(
          token,
          JWT_SECRET
        );


      /* ------------------------------------------------------------
         INVALIDATE SESSION
         
         This is important because the JWT itself remains valid
         until its expiry, but user_sessions.is_active becomes false.
      ------------------------------------------------------------ */

      if (
        decoded.session_id
      ) {

        await pool.query(
          `
          UPDATE user_sessions

          SET
            is_active = FALSE,
            invalidated_at = CURRENT_TIMESTAMP,
            invalidation_reason = 'logout'

          WHERE session_id = $1
          `,
          [
            decoded.session_id
          ]
        );

      }


      /* ------------------------------------------------------------
         CLEAR LEGACY SESSION TOKEN
      ------------------------------------------------------------ */

      await pool.query(
        `
        UPDATE user_table
        SET session_token = NULL
        WHERE user_id = $1
        `,
        [
          decoded.id
        ]
      );


      res.json({
        success: true
      });


    } catch {

      // Always succeed on logout
      res.json({
        success: true
      });

    }

  }
);


/* ================================================================
   POST /api/auth/change-password
================================================================ */

router.post(
  '/change-password',
  async (req, res) => {

    const {
      emailId,
      currentPassword,
      newPassword
    } = req.body;


    if (
      !emailId ||
      !currentPassword ||
      !newPassword
    ) {

      return res.status(400).json({
        error:
          'All fields are required'
      });

    }


    try {

      const {
        rows
      } = await pool.query(
        `
        SELECT
          user_id,
          password_hash

        FROM user_table

        WHERE LOWER(email_id) =
              LOWER($1)
        `,
        [
          emailId.trim()
        ]
      );


      if (!rows.length) {

        return res.status(404).json({
          error:
            'User not found'
        });

      }


      const user =
        rows[0];


      const isValid =
        user.password_hash ===
        'HASHED_PASSWORD'

          ? currentPassword ===
            'HASHED_PASSWORD'

          : await bcrypt.compare(
              currentPassword,
              user.password_hash
            );


      if (!isValid) {

        return res.status(401).json({
          error:
            'Current password is incorrect'
        });

      }


      const hash =
        await bcrypt.hash(
          newPassword,
          10
        );


      await pool.query(
        `
        UPDATE user_table
        SET password_hash = $1
        WHERE user_id = $2
        `,
        [
          hash,
          user.user_id
        ]
      );


      res.json({
        success: true
      });


    } catch (err) {

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   POST /api/auth/forgot-password
================================================================ */

router.post(
  '/forgot-password',
  async (req, res) => {

    const {
      step,
      emailId,
      userId,
      otpCode,
      newPassword
    } = req.body;


    const requestedStep =
      Number(step);


    if (
      ![1, 2, 3]
        .includes(requestedStep)
    ) {

      return res.status(400).json({
        error:
          'step must be 1, 2 or 3'
      });

    }


    if (
      requestedStep === 1 &&
      !emailId
    ) {

      return res.status(400).json({
        error:
          'emailId is required for step 1'
      });

    }


    if (
      [2, 3].includes(
        requestedStep
      ) &&
      (!userId || !otpCode)
    ) {

      return res.status(400).json({
        error:
          'userId and otpCode are required'
      });

    }


    if (
      requestedStep === 3 &&
      !newPassword
    ) {

      return res.status(400).json({
        error:
          'newPassword is required for step 3'
      });

    }


    try {

      /* ------------------------------------------------------------
         STEP 1 — SEND RESET OTP
      ------------------------------------------------------------ */

      if (
        requestedStep === 1
      ) {

        const {
          rows
        } = await pool.query(
          `
          SELECT
            user_id,
            user_name,
            email_id

          FROM user_table

          WHERE LOWER(email_id) =
                LOWER($1)
          `,
          [
            emailId.trim()
          ]
        );


        if (!rows.length) {

          return res.status(404).json({
            error:
              'No user found with this email address.'
          });

        }


        const user =
          rows[0];


        const otp =
          generateOTP();


        const exp =
          new Date(
            Date.now() +
            5 * 60 * 1000
          );


        await pool.query(
          `
          DELETE FROM otp_table

          WHERE user_id = $1
            AND verified = FALSE
          `,
          [
            user.user_id
          ]
        );


        await pool.query(
          `
          INSERT INTO otp_table
            (
              user_id,
              otp_code,
              expires_at
            )

          VALUES
            (
              $1,
              $2,
              $3
            )
          `,
          [
            user.user_id,
            otp,
            exp
          ]
        );


        const emailResult =
          await sendResetEmail(
            user.email_id,
            user.user_name,
            otp
          );


        const response = {

          success: true,

          userId:
            user.user_id,

          emailMasked:
            maskEmail(
              user.email_id
            )

        };


        if (
          emailResult.dev
        ) {

          response.otp =
            otp;

        }


        return res.json(
          response
        );

      }


      /* ------------------------------------------------------------
         STEP 2 / STEP 3 — VERIFY RESET OTP
      ------------------------------------------------------------ */

      const {
        rows
      } = await pool.query(
        `
        SELECT
          otp_id,
          otp_code,
          expires_at

        FROM otp_table

        WHERE user_id = $1
          AND verified = FALSE

        ORDER BY created_at DESC

        LIMIT 1
        `,
        [
          userId
        ]
      );


      if (!rows.length) {

        return res.status(401).json({
          error:
            'No pending OTP found.'
        });

      }


      const record =
        rows[0];


      if (
        new Date() >
        new Date(
          record.expires_at
        )
      ) {

        return res.status(401).json({
          error:
            'OTP expired. Please request a new one.'
        });

      }


      if (
        record.otp_code !==
        otpCode.trim()
      ) {

        return res.status(401).json({
          error:
            'Invalid OTP code.'
        });

      }


      /* ------------------------------------------------------------
         STEP 2 — ONLY VERIFY OTP
      ------------------------------------------------------------ */

      if (
        requestedStep === 2
      ) {

        return res.json({
          success: true,
          message:
            'OTP verified successfully.'
        });

      }


      /* ------------------------------------------------------------
         STEP 3 — CHANGE PASSWORD
      ------------------------------------------------------------ */

      if (
        newPassword.length < 6
      ) {

        return res.status(400).json({
          error:
            'Password must be at least 6 characters'
        });

      }


      await pool.query(
        `
        UPDATE otp_table
        SET verified = TRUE
        WHERE otp_id = $1
        `,
        [
          record.otp_id
        ]
      );


      const hash =
        await bcrypt.hash(
          newPassword,
          10
        );


      await pool.query(
        `
        UPDATE user_table
        SET password_hash = $1
        WHERE user_id = $2
        `,
        [
          hash,
          userId
        ]
      );


      return res.json({
        success: true,
        message:
          'Password updated successfully.'
      });


    } catch (err) {

      console.error(
        'Forgot password error:',
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   HELPER: SEND PASSWORD RESET EMAIL
================================================================ */

async function sendResetEmail(
  toEmail,
  userName,
  otp
) {

  if (!emailConfigured) {

    console.log(
      `[DEV] Reset OTP for ${toEmail}: ${otp}`
    );

    return {
      dev: true
    };

  }


  await transporter.sendMail({

    from:
      `"Web GIS Plant Portal" <${process.env.SMTP_FROM}>`,

    to:
      toEmail,

    subject:
      'Password Reset OTP — Web GIS Plant Portal',

    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;
                  border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

        <div style="background:#1e3a5f;padding:24px;text-align:center;">
          <h2 style="color:#fff;margin:0;">
            🔑 Password Reset
          </h2>
        </div>

        <div style="padding:28px 24px;">

          <p style="color:#374151;font-size:15px;">
            Hello <strong>${userName}</strong>,
          </p>

          <p style="color:#374151;font-size:14px;">
            Use this OTP to reset your password:
          </p>

          <div style="background:#eff6ff;border:2px solid #bfdbfe;
                      border-radius:10px;padding:20px;text-align:center;
                      margin:20px 0;">

            <span style="font-size:36px;font-weight:900;
                         letter-spacing:12px;color:#1e3a5f;">
              ${otp}
            </span>

          </div>

          <p style="color:#6b7280;font-size:13px;">
            ⏱ Valid for <strong>5 minutes</strong>.
            Do not share this code.
          </p>

        </div>

      </div>
    `

  });


  return {
    sent: true
  };

}


/* ================================================================
   POST /api/auth/force-logout-session
================================================================ */

router.post(
  '/force-logout-session',
  async (req, res) => {

    const {
      session_id
    } = req.body;


    if (!session_id) {

      return res.status(400).json({
        error:
          'session_id is required'
      });

    }


    try {

      await pool.query(
        `
        UPDATE user_sessions

        SET
          is_active = FALSE,
          invalidated_at = CURRENT_TIMESTAMP,
          invalidation_reason =
            'forced_logout_by_new_login'

        WHERE session_id = $1
        `,
        [
          session_id
        ]
      );


      res.json({

        success: true,

        message:
          'Session invalidated successfully'

      });


    } catch (err) {

      console.error(
        'force-logout-session error:',
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   POST /api/auth/issue-token
================================================================ */

router.post(
  '/issue-token',
  async (req, res) => {

    const {
      userId
    } = req.body;


    if (!userId) {

      return res.status(400).json({
        error:
          'userId is required'
      });

    }


    try {

      /* ------------------------------------------------------------
         FETCH USER + ROLE
      ------------------------------------------------------------ */

      const {
        rows
      } = await pool.query(
        `
        SELECT
          u.user_id,
          u.user_name,
          u.email_id,
          u.phone_number,

          TRIM(r.role_name) AS "roleName",
          r.feature_allowed AS "featureAllowed"

        FROM user_table u

        JOIN role_table r
          ON u.role_id = r.role_id

        WHERE u.user_id = $1
        `,
        [
          userId
        ]
      );


      if (!rows.length) {

        return res.status(404).json({
          error:
            'User not found'
        });

      }


      const record =
        rows[0];


      /* ------------------------------------------------------------
         GENERATE NEW SESSION ID
      ------------------------------------------------------------ */

      const sessionId =
        crypto
          .randomBytes(16)
          .toString('hex');


      /* ------------------------------------------------------------
         GET DEVICE INFORMATION
      ------------------------------------------------------------ */

      const {
        deviceType,
        ipAddress,
        location
      } = getDeviceInfo(req);


      console.log(
        'New issue-token device information:',
        {
          deviceType,
          ipAddress,
          location
        }
      );


      /* ------------------------------------------------------------
         UPDATE LEGACY SESSION TOKEN
      ------------------------------------------------------------ */

      await pool.query(
        `
        UPDATE user_table

        SET session_token = $1

        WHERE user_id = $2
        `,
        [
          sessionId,
          userId
        ]
      );


      /* ------------------------------------------------------------
         SESSION EXPIRY
      ------------------------------------------------------------ */

      const expiresAt =
        new Date(
          Date.now() +
          8 * 60 * 60 * 1000
        );


      /* ------------------------------------------------------------
         INSERT NEW USER SESSION
      ------------------------------------------------------------ */

      await pool.query(
        `
        INSERT INTO user_sessions
        (
          user_id,
          session_id,
          is_active,
          created_at,
          last_activity,
          expires_at,
          device_type,
          location,
          ip_address
        )

        VALUES
        (
          $1,
          $2,
          TRUE,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          $3,
          $4,
          $5,
          $6
        )
        `,
        [
          userId,
          sessionId,
          expiresAt,
          deviceType,
          location,
          ipAddress
        ]
      );


      /* ------------------------------------------------------------
         CREATE JWT
         
         IMPORTANT:
         Use session_id to match authMiddleware.
      ------------------------------------------------------------ */

      const role =
        record.roleName
          .trim()
          .toUpperCase();


      const token =
        jwt.sign(
          {

            id:
              Number(userId),

            email:
              record.email_id,

            role:
              role === 'REVIEWER'
                ? 'MANAGER'
                : role,

            session_id:
              sessionId

          },

          JWT_SECRET,

          {
            expiresIn: '8h'
          }
        );


      /* ------------------------------------------------------------
         RESPONSE
      ------------------------------------------------------------ */

      res.json({

        success: true,

        userId,

        userName:
          record.user_name,

        emailId:
          record.email_id,

        phoneNumber:
          record.phone_number,

        roleName:
          record.roleName,

        featureAllowed:
          record.featureAllowed,

        token

      });


    } catch (err) {

      console.error(
        'issue-token error:',
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });

    }

  }
);


/* ================================================================
   EXPORT ROUTER
================================================================ */

module.exports = router;