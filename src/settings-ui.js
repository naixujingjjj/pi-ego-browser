// The `/ego-settings` TUI: one settings list, the browser-status panel and the
// session's screenshot panel.
//
// The setting ids are fixed because the command acts on them, and the order
// keeps the two directory rows where they always were:
//   info       → this panel: exactly the text `/ego-settings status` prints,
//                Esc goes back here
//   directory  → closes the list so the command can open the native folder picker
//   reset      → only offered while a preferred directory is set
//   shots      → the session's screenshots; picking one opens it with the OS
//                viewer, and a row asks for an ID (older pictures included)
//   resume     → only offered while the user holds the browser; the command
//                takes control back and re-reads the page
//
// Esc inside a panel returns to the list (that is the settings submenu closing,
// not the whole screen); Esc in the list still closes the settings.
import { formatBytes, shortId } from "./attachments.js";

export function statusPanel(tui, theme, keybindings, { text, done }) {
  const { Container, Text } = tui;
  const body = String(text ?? "").trim() || "No status available.";
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("Info · Browser Status")), 0, 1));
  container.addChild(new Text(body, 0, 1));
  container.addChild(
    new Text(
      theme.fg("dim", "Esc returns to settings. Press Esc again to exit settings."),
      0,
      0,
    ),
  );
  container.handleInput = (data) => {
    if (keybindings?.matches?.(data, "tui.select.cancel")) done();
  };
  return container;
}

/**
 * The session's screenshots, as one more settings page.
 *
 * Every row names the picture, its size, page and absolute file path, so the
 * row is useful even when the OS viewer cannot be started. Selecting a row
 * closes the settings with `open:<id>`; the command then verifies and opens the
 * file through the same path an ID typed in a terminal takes. `Open by ID…`
 * covers pictures older than this short list: only this session's own IDs are
 * accepted, exactly as for lookback.
 */
export function screenshotsPanel(tui, theme, keybindings, { shots, done }) {
  const { Container, Text } = tui;
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("Session Screenshots")), 0, 1));
  const rows = Array.isArray(shots) ? shots : [];
  if (!rows.length) {
    container.addChild(new Text("No screenshots in this session.", 0, 1));
    container.addChild(new Text(theme.fg("dim", "Esc returns to settings."), 0, 0));
    container.handleInput = (data) => {
      if (keybindings?.matches?.(data, "tui.select.cancel")) done();
    };
    return container;
  }

  const palette = {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
  const items = [
    {
      id: "open-id",
      label: "Open by ID…",
      currentValue: "",
      description: "Enter the 64-character screenshot ID or a unique prefix to open it in the default image viewer.",
      values: [""],
    },
    ...rows.map((shot) => {
      const when = shot.at ? new Date(shot.at).toLocaleString("en-US") : "";
      return {
        id: `shot-${shot.id}`,
        label: `${shortId(shot.id)}…`,
        currentValue: [formatBytes(shot.bytes), shot.pageLabel || "", when].filter(Boolean).join(" · "),
        description: shot.available === false
          ? `Unavailable: ${shot.message || "File missing"}`
          : `File: ${shot.path || "(resolving path)"}. Press Enter to open it in the default image viewer.`,
        values: [""],
      };
    }),
  ];
  const list = new tui.SettingsList(
    items,
    Math.min(items.length, 12),
    palette,
    (id) => done(id === "open-id" ? "open-id" : `open:${id.slice("shot-".length)}`),
    () => done(),
  );
  container.addChild(list);
  container.handleInput = (data) => {
    list.handleInput(data);
  };
  return container;
}

export function chooseEgoSetting(
  ctx,
  tui,
  { preferred, defaultDir, statusText, statusSummary = "", statusFailed = false, handedOff = false, shots = [] },
) {
  return ctx.ui.custom((host, theme, keybindings, done) => {
    const items = [
      {
        id: "info",
        label: "Info",
        currentValue: statusSummary || "Browser Status",
        // Activating this row opens the panel instead of closing the settings.
        description: "Press Enter to view browser status. Press Esc to go back.",
        submenu: (_currentValue, close) => statusPanel(tui, theme, keybindings, { text: statusText, done: close }),
      },
      {
        id: "directory",
        label: "Screenshot Folder",
        currentValue: preferred || "Default",
        description: `Press Enter to choose a folder. If it is unavailable, new screenshots are saved to the default folder at ${defaultDir}.`,
        // Activating this row closes the list; the command opens the picker.
        values: [preferred || "Default"],
      },
    ];
    if (preferred) {
      items.push({
        id: "reset",
        label: "Restore Default Folder",
        currentValue: "",
        description: `Save new screenshots to ${defaultDir}.`,
        values: [""],
      });
    }
    items.push({
      id: "shots",
      label: "Session Screenshots",
      currentValue: `${Array.isArray(shots) ? shots.length : 0}`,
      description: "Press Enter to browse screenshots from this session or open an older screenshot by ID.",
      submenu: (_currentValue, close) => screenshotsPanel(tui, theme, keybindings, { shots, done: close }),
    });
    if (handedOff) {
      items.push({
        id: "resume",
        label: "Resume Browser Control",
        currentValue: "Waiting for you",
        description: "Press Enter when you are done. Pi will take control, read the current page again, and continue the task.",
        values: [""],
      });
    }

    const list = new tui.SettingsList(
      items,
      items.length,
      {
        label: (text, selected) => (selected ? theme.fg("accent", text) : text),
        value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
        description: (text) => theme.fg("dim", text),
        cursor: theme.fg("accent", "→ "),
        hint: (text) => theme.fg("dim", text),
      },
      (id, value) => {
        if (id === "shots") {
          // The screenshot panel reports the picture it wants opened.
          if (value === "open-id" || (typeof value === "string" && value.startsWith("open:"))) done(value);
          return;
        }
        if (id === "directory" || id === "reset" || id === "resume") done(id);
      },
      () => done(undefined),
    );

    const container = new tui.Container();
    container.addChild(
      new tui.Text(theme.fg("accent", theme.bold(statusFailed ? "Ego Browser Settings (status unavailable)" : "Ego Browser Settings")), 0, 1),
    );
    container.addChild(list);
    container.handleInput = (data) => {
      list.handleInput(data);
      host.requestRender();
    };
    return container;
  });
}
