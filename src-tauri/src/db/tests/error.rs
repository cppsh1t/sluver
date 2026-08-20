use super::*;

#[test]
fn space_not_found_payload() {
    let p = DbError::SpaceNotFound("abc".into()).to_payload();
    assert_eq!(p.code, "SPACE_NOT_FOUND");
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn space_name_taken_payload() {
    let p = DbError::SpaceNameTaken("My Space".into()).to_payload();
    assert_eq!(p.code, "SPACE_NAME_TAKEN");
    assert_eq!(p.args.get("name"), Some(&"My Space".to_string()));
}

#[test]
fn space_password_required_payload() {
    let p = DbError::SpacePasswordRequired("abc".into()).to_payload();
    assert_eq!(p.code, "SPACE_PASSWORD_REQUIRED");
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn space_wrong_password_payload() {
    let p = DbError::SpaceWrongPassword("abc".into()).to_payload();
    assert_eq!(p.code, "SPACE_WRONG_PASSWORD");
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn invalid_input_payload() {
    let p = DbError::InvalidInput("bad id".into()).to_payload();
    assert_eq!(p.code, "INVALID_INPUT");
    assert_eq!(p.args.get("message"), Some(&"bad id".to_string()));
}

#[test]
fn note_parent_not_folder_payload() {
    let p = DbError::NoteParentNotFolder("abc".into()).to_payload();
    assert_eq!(p.code, "NOTE_PARENT_NOT_FOLDER");
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn note_move_cycle_payload() {
    let p = DbError::NoteMoveCycle("abc".into()).to_payload();
    assert_eq!(p.code, "NOTE_MOVE_CYCLE");
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn skill_not_found_payload() {
    let p = DbError::SkillNotFound("abc".into()).to_payload();
    assert_eq!(p.code, "SKILL_NOT_FOUND");
    assert_eq!(p.args.get("entity"), Some(&"skill".to_string()));
    assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
}

#[test]
fn skill_package_invalid_payload() {
    let p = DbError::SkillPackageInvalid("not a zip".into()).to_payload();
    assert_eq!(p.code, "SKILL_PACKAGE_INVALID");
    assert_eq!(p.args.get("reason"), Some(&"not a zip".to_string()));
}

#[test]
fn skill_not_installed_payload() {
    let p = DbError::SkillNotInstalled("my-skill".into()).to_payload();
    assert_eq!(p.code, "SKILL_NOT_INSTALLED");
    assert_eq!(p.args.get("name"), Some(&"my-skill".to_string()));
}

#[test]
fn attachment_too_large_payload() {
    let p = DbError::AttachmentTooLarge {
        kind: "image".into(),
        max_bytes: 5 * 1024 * 1024,
    }
    .to_payload();
    assert_eq!(p.code, "ATTACHMENT_TOO_LARGE");
    assert_eq!(p.args.get("kind"), Some(&"image".to_string()));
    // `max` is MiB-formatted for direct {{max}} interpolation.
    assert_eq!(p.args.get("max"), Some(&"5 MiB".to_string()));
}

#[test]
fn attachment_invalid_mime_payload() {
    let p = DbError::AttachmentInvalidMime("application/pdf".into()).to_payload();
    assert_eq!(p.code, "ATTACHMENT_INVALID_MIME");
    assert_eq!(p.args.get("mime"), Some(&"application/pdf".to_string()));
}

#[test]
fn attachment_invalid_text_payload() {
    let p = DbError::AttachmentInvalidText.to_payload();
    assert_eq!(p.code, "ATTACHMENT_INVALID_TEXT");
    assert!(p.args.is_empty());
}

/// Regression guard: existing variants must keep their stable codes.
#[test]
fn existing_codes_unchanged() {
    assert_eq!(
        DbError::WorldNotFound("w1".into()).to_payload().code,
        "WORLD_NOT_FOUND"
    );
    let p = DbError::NotFound("Character", "c1".into()).to_payload();
    assert_eq!(p.code, "NOT_FOUND");
    assert_eq!(p.args.get("entity"), Some(&"Character".to_string()));
    assert_eq!(p.args.get("id"), Some(&"c1".to_string()));
    assert_eq!(
        DbError::Internal("boom".into()).to_payload().code,
        "INTERNAL_ERROR"
    );
    // New attachment codes (ADR-0044) — pinned here so they stay stable.
    assert_eq!(
        DbError::AttachmentTooLarge {
            kind: "text".into(),
            max_bytes: 1024 * 1024,
        }
        .to_payload()
        .code,
        "ATTACHMENT_TOO_LARGE"
    );
    assert_eq!(
        DbError::AttachmentInvalidMime("image/gif".into())
            .to_payload()
            .code,
        "ATTACHMENT_INVALID_MIME"
    );
    assert_eq!(
        DbError::AttachmentInvalidText.to_payload().code,
        "ATTACHMENT_INVALID_TEXT"
    );
}
