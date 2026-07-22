# API keys are stored as plaintext in `space.db`

`provider_credentials.api_key` stores the provider API key as plaintext TEXT, with no application-layer encryption. This is a deliberate choice for v1.

Threat model: the `space.db` file lives under the user's OS user directory (`app_data_dir/spaces/{spaceId}/space.db`). An attacker who can read this file already has the user's OS privileges — they can also read `meta.db`, run the app, and type in any password the user has set. Application-layer encryption (e.g. encrypting `api_key` with a key derived from the Space password) would only defend against the narrow scenario of "DB file exfiltrated but attacker has no OS access" — and even then, if the Space has no password (the common case, since Space passwords are optional per ADR-0008), there is no key to derive from. The security gain is marginal relative to the complexity cost: key derivation, re-encryption on password change, total loss of keys on forgotten password, and a per-row IV column.

This mirrors the threat-model reasoning of ADR-0008 (Space password is an auth gate, not at-rest encryption): for a single-user desktop app, defense against the casual snooper at the application boundary is the right level; defense against a forensic adversary with disk access is out of scope.

Upgrade path: if genuine at-rest protection becomes a requirement, the change is additive — add an `api_key_iv` column, derive a key from the Space password (or an OS keyring secret via Windows DPAPI / macOS Keychain / Linux Secret Service), and migrate existing rows in a background job. The `provider_credentials` schema does not need to change shape; only the write/read paths gain an encrypt/decrypt step.
