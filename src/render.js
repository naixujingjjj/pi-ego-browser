// TUI rendering for screenshot rows.
//
// The row always shows text: the attachment ID, size, root and the absolute file
// path. The image is read from disk only when the row is expanded and Pi has
// images enabled, so loading a session never pulls historical PNGs into memory,
// and a plain-text or RPC surface keeps working with the path and ID alone.
export function createScreenshotView(tui, { text, loadImage, theme, showImages = true, maxWidthCells = 60 } = {}) {
  const { Text, Image } = tui;
  const textComponent = new Text(text, 0, 0);
  let image = null;
  let attempted = false;
  let retryAt = 0;
  let lastFailure = null;

  const component = {
    render(width) {
      const lines = [...textComponent.render(width)];
      if (showImages && Image) {
        if (!image && (!attempted || Date.now() >= retryAt)) {
          attempted = true;
          retryAt = Date.now() + 5000;
          try {
            const source = loadImage?.();
            if (source?.data) {
              image = new Image(
                source.data,
                source.mimeType || "image/png",
                { fallbackColor: (value) => theme.fg("toolOutput", value) },
                { maxWidthCells, filename: source.filename },
              );
              lastFailure = null;
            } else if (source?.error) {
              lastFailure = source.error;
            }
          } catch (error) {
            lastFailure = String(error?.message || error);
          }
        }
        if (image) {
          lines.push("", ...image.render(width));
        } else if (lastFailure) {
          lines.push("", theme.fg("warning", `图片不可用：${lastFailure}`));
        }
      }
      return lines;
    },
    invalidate() {
      textComponent.invalidate();
      image?.invalidate();
    },
  };
  return component;
}