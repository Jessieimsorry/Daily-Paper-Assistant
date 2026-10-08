"use strict";
const path = require("node:path"),
  os = require("node:os");
function home() {
  return process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "DailyPaperAssistant",
      )
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "LitDesk")
      : path.join(
          process.env.XDG_DATA_HOME ||
            path.join(os.homedir(), ".local", "share"),
          "daily-paper-assistant",
        );
}
module.exports = {
  home,
  data: () =>
    process.env.LITDESK_DATA_DIR
      ? path.resolve(process.env.LITDESK_DATA_DIR)
      : path.join(home(), "data"),
};
