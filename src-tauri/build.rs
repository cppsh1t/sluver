fn main() {
    // Windows/MSVC: embed the Common-Controls v6 manifest via the LINKER instead
    // of tauri-build's default resource-based embedding.
    //
    // Why: `tauri-plugin-dialog` unconditionally enables rfd's
    // `common-controls-v6` feature on Windows, which statically imports
    // `TaskDialogIndirect` from comctl32.dll. That export only exists in
    // comctl32 v6, which the loader only binds when the exe declares the
    // `Microsoft.Windows.Common-Controls` side-by-side assembly in an embedded
    // RT_MANIFEST. tauri-build's default embeds the manifest as a compiled .rc
    // resource, which only reaches `[[bin]]` targets — cargo's auto-generated
    // test harness exe gets NO manifest, resolves comctl32 to the v5.82
    // System32 copy, and dies at process start with 0xc0000139
    // STATUS_ENTRYPOINT_NOT_FOUND (upstream: tauri-apps/tauri#13419, still
    // open as of tauri-build 2.6.3; maintainer-endorsed workaround from
    // tauri-apps/tauri#11028, same pattern the tauri repo uses in
    // examples/api/src-tauri/build.rs).
    //
    // How: `cargo:rustc-link-arg` (unlike `-bins`) applies to every linked
    // target, including the lib unit-test harness, so `/MANIFEST:EMBED` +
    // `/MANIFESTINPUT` covers both the app binary and test executables. The
    // resource-based manifest is suppressed via `new_without_app_manifest()`
    // to avoid a duplicate RT_MANIFEST (LNK1123).
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let is_windows_msvc = target_os == "windows" && target_env == "msvc";

    let attributes = if is_windows_msvc {
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };

    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    if is_windows_msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
