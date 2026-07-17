# Space password is an auth gate (argon2id hash), not at-rest encryption

A Space may be created with a password. The password is stored as an **argon2id hash** in `meta.db` and used purely as an authentication gate: opening such a Space, and returning to it from the system tray, requires re-entering the password. The Space's data files remain plain SQLite on disk.

Threat model: a casual snooper who has momentary access to the running or tray-hidden app (a housemate, a borrowed laptop, a colleague glancing over). This is **not** a defence against a forensic adversary who acquires the disk image — they can read the unencrypted `.db` files directly. We chose hash-only over at-rest encryption (e.g. SQLCipher with a key derived from the password) because for a single-user novel-writing app the encryption stack is over-engineering relative to the threat, and it would force a rewrite of the connection/migration layer. The choice is recorded because "password-protected Space" implies encryption to a naive reader.

Upgrade path: if genuine at-rest protection becomes a requirement, encryption is an additive layer — derive a key from the password and encrypt future Space files — without changing the auth-gate UX. That would be a new ADR.
