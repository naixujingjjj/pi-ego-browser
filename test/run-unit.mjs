// Runs every unit test in one process, so the suite works even in sandboxes
// that refuse to spawn a child per test file (node --test does that by default).
import "./session.test.mjs";
import "./script.test.mjs";
import "./runtime.test.mjs";
import "./chromium.test.mjs";
import "./tools.test.mjs";
import "./attachments.test.mjs";
import "./review.test.mjs";
import "./command.test.mjs";
import "./render.test.mjs";
import "./folder-picker.test.mjs";
import "./ego-extension.test.mjs";
import "./pi-session.test.mjs";
import "./packaging.test.mjs";