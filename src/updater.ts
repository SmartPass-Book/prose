import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";

async function runUpdateCheck(opts: { interactive: boolean }) {
  try {
    const update = await check();
    if (update) {
      console.log(`update available: ${update.version} (${update.date})`);
      await update.downloadAndInstall();
      await relaunch();
      return;
    }
    if (opts.interactive) {
      const v = await getVersion();
      await message(`Prose ${v} is the latest version.`, {
        title: "You're up to date",
        kind: "info",
      });
    }
  } catch (e) {
    console.error("update check failed", e);
    if (opts.interactive) {
      await message(String(e), { title: "Update check failed", kind: "error" });
    }
  }
}

export async function checkForUpdates() {
  await runUpdateCheck({ interactive: false });
}

export function registerUpdateMenuListener() {
  return listen("menu://check-for-updates", () => {
    void runUpdateCheck({ interactive: true });
  });
}
