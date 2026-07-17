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
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify_roundtrip() {
        let phc = hash_password("correct horse battery staple").expect("hash should succeed");
        let ok =
            verify_password("correct horse battery staple", &phc).expect("verify should not error");
        assert!(ok, "round-trip verify must return true");
    }

    #[test]
    fn test_verify_wrong_password_returns_false() {
        let phc = hash_password("hunter2").expect("hash should succeed");
        let ok = verify_password("not-the-password", &phc).expect("verify should not error");
        assert!(!ok, "wrong password must return Ok(false), not Err");
    }

    #[test]
    fn test_empty_password_roundtrip() {
        // Empty string is a valid (if weak) password — must hash+verify cleanly.
        let phc = hash_password("").expect("hash of empty string should succeed");
        let ok = verify_password("", &phc).expect("verify of empty string should not error");
        assert!(ok, "empty password round-trip must verify true");
    }

    #[test]
    fn test_empty_plain_against_non_empty_hash_is_false() {
        let phc = hash_password("real-secret").expect("hash should succeed");
        let ok = verify_password("", &phc).expect("verify should not error");
        assert!(!ok, "empty guess against non-empty hash must be Ok(false)");
    }

    #[test]
    fn test_verify_malformed_phc_returns_error() {
        let res = verify_password("anything", "this-is-not-a-phc-string");
        assert!(res.is_err(), "malformed PHC must return Err, not Ok(false)");
        match res.unwrap_err() {
            DbError::Internal(_) => {} // expected bucket per current additive design
            other => panic!("expected DbError::Internal for malformed PHC, got {other:?}"),
        }
    }

    #[test]
    fn test_verify_empty_phc_returns_error() {
        let res = verify_password("anything", "");
        assert!(res.is_err(), "empty stored PHC must return Err");
    }

    #[test]
    fn test_different_salts_produce_different_hashes() {
        let a = hash_password("same-password").expect("hash should succeed");
        let b = hash_password("same-password").expect("hash should succeed");
        assert_ne!(
            a, b,
            "two hashes of the same password must differ (random salt)"
        );
    }

    #[test]
    fn test_hashed_string_is_argon2id_phc_format() {
        let phc = hash_password("sample").expect("hash should succeed");
        assert!(
            phc.starts_with("$argon2id$v=19$m="),
            "PHC must be argon2id v19 with m= param, got: {phc}"
        );
    }
}
