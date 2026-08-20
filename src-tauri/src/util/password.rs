//! argon2id password hashing utilities — auth-gate only, NOT encryption.
//!
//! Per ADR-0008, a Space's optional password is an authentication gate: we
//! store an argon2id PHC string in `meta.db` and verify it before opening the
//! Space's `space.db`. There is NO at-rest encryption (SQLCipher is explicitly
//! forbidden by ADR-0008).
//!
//! The PHC string embeds the algorithm, parameters, and salt, so it is the
//! ONLY value that needs to be persisted. Verification parses the STORED PHC
//! (via `PasswordHash::new`) and hands its params+salt to the verifier — we
//! never re-derive with `Argon2::default()`'s params on the verify path. This
//! sidesteps the standard argon2 copy-paste bug flagged as risk 🟡 in the
//! Space-layer plan (T11 password lifecycle) and future-proofs us against
//! parameter rotation.

use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;

use crate::db::error::DbError;

/// Hash a plaintext password, returning the argon2id PHC string.
///
/// Uses `Argon2::default()` — Argon2id with OWASP first-tier parameters
/// (`m=19456`, `t=2`, `p=1`) — and a fresh random salt per call. The returned
/// PHC string embeds the algorithm, params, and salt, so callers must persist
/// it verbatim (no separate salt column).
pub fn hash_password(plain: &str) -> Result<String, DbError> {
    let salt = SaltString::generate(&mut OsRng);
    let phc = Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| DbError::Internal(format!("argon2 hash failed: {e}")))?
        .to_string();
    Ok(phc)
}

/// Verify a plaintext password against a stored argon2id PHC string.
///
/// CRITICAL: parses the STORED hash via `PasswordHash::new(stored_phc)` and
/// passes its parsed params+salt to the verifier — never re-derives. This is
/// the argon2 copy-paste bug; the design here makes it impossible.
///
/// # Return value
/// - `Ok(true)` — password matches the stored hash.
/// - `Ok(false)` — password does NOT match. Wrong password is a normal
///   outcome (NOT an error) so callers can implement retry/attempts logic.
/// - `Err(DbError)` — the stored PHC is malformed or an infra error occurred.
// TODO(T5): DbError may gain a dedicated `PasswordHash` variant for malformed
// stored PHC inputs. For now we route to `DbError::Internal` so this wave is
// purely additive and does not touch `db/error.rs`.
pub fn verify_password(plain: &str, stored_phc: &str) -> Result<bool, DbError> {
    let parsed = PasswordHash::new(stored_phc)
        .map_err(|e| DbError::Internal(format!("invalid stored PHC: {e}")))?;
    match Argon2::default().verify_password(plain.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        // `Error::Password` is the canonical "password does not match" signal
        // from the `password-hash` crate — surface it as a normal `Ok(false)`.
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(DbError::Internal(format!("argon2 verify failed: {e}"))),
    }
}

#[cfg(test)]
#[path = "tests/password.rs"]
mod tests;
