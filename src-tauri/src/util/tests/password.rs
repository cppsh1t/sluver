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
