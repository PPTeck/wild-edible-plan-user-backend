'use strict';
/**
 * AES-256-CBC encrypt/decrypt — OpenSSL EVP_BytesToKey format.
 * Must match Angular's CryptoService which uses CryptoJS.AES.
 *
 * Wire format: Base64( "Salted__" | salt(8) | ciphertext )
 */
require('dotenv').config();
const CryptoJS = require('crypto-js');

const SECRET_KEY = process.env.CRYPTO_KEY;

function encrypt(plaintext) {
  return CryptoJS.AES.encrypt(plaintext, SECRET_KEY).toString();
}

function decrypt(token) {
  const bytes = CryptoJS.AES.decrypt(token, SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
