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

export function statusPanel(tui, theme, keybindings, { text, failed = false, done }) {
  const { Container, Text } = tui;
  const body = String(text ?? "").trim() || "（没有可显示的状态）";
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("info · 浏览器状态")), 0, 1));
  container.addChild(new Text(body, 0, 1));
  container.addChild(
    new Text(
      theme.fg("dim", failed ? "状态没有读成功时也能返回设置；Esc 返回，再按 Esc 退出设置。" : "Esc 返回设置；在设置里再按 Esc 退出。"),
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
 * file through the same path an ID typed in a terminal takes. `按 ID 打开…`
 * covers pictures older than this short list: only this session's own IDs are
 * accepted, exactly as for lookback.
 */
export function screenshotsPanel(tui, theme, keybindings, { shots, done }) {
  const { Container, Text } = tui;
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold("本会话截图")), 0, 1));
  const rows = Array.isArray(shots) ? shots : [];
  if (!rows.length) {
    container.addChild(new Text("这个会话还没有截图。用 browser_screenshot 拍一张后，这里会列出它的 ID 和文件路径。", 0, 1));
    container.addChild(new Text(theme.fg("dim", "Esc 返回设置。"), 0, 0));
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
      label: "按 ID 打开…",
      currentValue: "",
      description: "输入截图附件 ID（完整 64 位或唯一前缀），用系统默认程序打开；旧截图也能这样打开。",
      values: [""],
    },
    ...rows.map((shot) => {
      const when = shot.at ? new Date(shot.at).toLocaleString("zh-CN") : "";
      return {
        id: `shot-${shot.id}`,
        label: `${shortId(shot.id)}…`,
        currentValue: [formatBytes(shot.bytes), shot.pageLabel || "", when].filter(Boolean).join(" · "),
        description: shot.available === false
          ? `不可用：${shot.message || "文件不在了"}`
          : `文件：${shot.path || "（解析附件库路径）"}。按 Enter 用系统默认程序打开。`,
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
        label: "info",
        currentValue: statusSummary || "浏览器状态",
        // Activating this row opens the panel instead of closing the settings.
        description: "显示与 /ego-settings status 完全相同的浏览器状态。按 Enter 查看，Esc 返回这一层。",
        submenu: (_currentValue, close) => statusPanel(tui, theme, keybindings, { text: statusText, failed: statusFailed, done: close }),
      },
      {
        id: "directory",
        label: "截图附件目录",
        currentValue: preferred || "默认目录",
        description: `按 Enter 打开 Windows 文件夹选择器并直接选目录；默认目录 ${defaultDir}。首选目录不可写时，新截图会保存到默认目录。`,
        // Activating this row closes the list; the command opens the picker.
        values: [preferred || "默认目录"],
      },
    ];
    if (preferred) {
      items.push({
        id: "reset",
        label: "恢复默认目录",
        currentValue: "",
        description: `以后拍摄的截图将使用 ${defaultDir}。`,
        values: [""],
      });
    }
    items.push({
      id: "shots",
      label: "本会话截图",
      currentValue: `${Array.isArray(shots) ? shots.length : 0} 张`,
      description: "按 Enter 看本会话的截图：选一张用系统默认程序打开，或按 ID 打开更早的一张。",
      submenu: (_currentValue, close) => screenshotsPanel(tui, theme, keybindings, { shots, done: close }),
    });
    if (handedOff) {
      items.push({
        id: "resume",
        label: "恢复浏览器控制",
        currentValue: "等待用户处理",
        description: "用户手动处理完成后，按 Enter 把控制权交还 Pi、重新读取当前页面并继续任务。只有你主动选这一行才会恢复。",
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
      new tui.Text(theme.fg("accent", theme.bold(statusFailed ? "Ego 浏览器设置（状态读取失败）" : "Ego 浏览器设置")), 0, 1),
    );
    container.addChild(list);
    container.handleInput = (data) => {
      list.handleInput(data);
      host.requestRender();
    };
    return container;
  });
}