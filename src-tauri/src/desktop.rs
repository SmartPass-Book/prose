//! Everything the desktop build has and the mobile build doesn't.
//!
//! This module is the single seam between the two platforms in the Rust
//! backend. It is compiled only on desktop (see the `#[cfg(desktop)] mod
//! desktop;` in `lib.rs`), so the code inside needs no further gating, and
//! `run()` carries exactly one platform branch instead of an inline block.
//!
//! Two things live here:
//!
//! - The **native menu bar**, which iOS has no equivalent of.
//! - The **updater plugin**, which has no mobile implementation at all;
//!   `tauri-plugin-updater` is a target-gated dependency in `Cargo.toml` and
//!   isn't even linked on iOS, where updates would come from the App Store.
//!
//! The matching frontend seam is `src/lib/platform.ts`.

use tauri::{
    menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    Builder, Emitter, Wry,
};

/// Register the desktop-only plugins and menu on the app builder.
pub fn extend(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(|app| {
            let about = AboutMetadataBuilder::new()
                .name(Some("Prose"))
                .version(Some(app.package_info().version.to_string()))
                .build();
            let check_updates =
                MenuItemBuilder::with_id("check_for_updates", "Check for Updates...").build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Prose")
                .about(Some(about))
                .item(&check_updates)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;
            MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id() == "check_for_updates" {
                // Picked up by registerUpdateMenuListener() in updater.ts for
                // an interactive check that surfaces "you're up to date".
                let _ = app.emit("menu://check-for-updates", ());
            }
        })
}
