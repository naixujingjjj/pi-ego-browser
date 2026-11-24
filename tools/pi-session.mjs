// In-process Pi session on a local faux provider.
//
// Used by the unit suite and the acceptance run to verify, without a network or
// a browser, what Pi actually does: which messages are written to the session
// JSONL, what the model receives per request, and how an extension's `context`
// hook changes a request without touching the transcript. Everything lives in
// the caller's scratch directory: its own agent dir, its own session dir, its
// own auth path.
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiPackage } from "./harness.mjs";

let cachedHost = null;

export async function loadPiHost() {
  if (cachedHost) return cachedHost;
  const pi = resolvePiPackage();
  const coding = await import(pathToFileURL(join(pi.packageRoot, "dist", "index.js")).href);
  const ai = await import(
    pathToFileURL(join(pi.packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href
  );
  cachedHost = { pi, coding, ai };
  return cachedHost;
}

/** What one model request carried, for assertions. */
export function summarizeContext(context) {
  const images = [];
  const roles = [];
  for (const message of context.messages) {
    roles.push(message.role);
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image") {
        images.push({
          role: message.role,
          toolCallId: message.toolCallId ?? null,
          toolName: message.toolName ?? null,
          mimeType: part.mimeType,
          bytes: String(part.data || "").length,
          digest: createHash("sha256").update(String(part.data || "")).digest("hex").slice(0, 12),
        });
      }
    }
  }
  return { roles, images };
}

/**
 * A faux step: records what the model received, then answers with one assistant
 * message that may contain tool calls and text.
 */
export function scriptedStep(ai, received, script = {}) {
  return async (context) => {
    received.push(summarizeContext(context));
    const content = [];
    for (const call of script.toolCalls || []) {
      content.push(ai.fauxToolCall(call.name, call.arguments || {}, call.id ? { id: call.id } : {}));
    }
    if (script.text) content.push(ai.fauxText(script.text));
    return ai.fauxAssistantMessage(content);
  };
}

/**
 * Create one Pi session with a faux provider and the given extensions.
 * `env` is applied to `process.env` for the session's lifetime so an extension
 * factory sees its isolated state root.
 */
export async function createFauxSession({
  workDir,
  extensionPaths = [],
  extensionFactories = [],
  modelDefinitions = [
    { id: "vision", input: ["text", "image"] },
    { id: "textonly", input: ["text"] },
  ],
  modelId = "vision",
  env = {},
  systemPrompt = "Test session. Use the available tools when asked.",
} = {}) {
  const { coding, ai } = await loadPiHost();
  mkdirSync(workDir, { recursive: true });
  const agentDir = join(workDir, "agent");
  const sessionDir = join(workDir, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    process.env[key] = String(value);
  }

  const modelRuntime = await coding.ModelRuntime.create({
    authPath: join(workDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = ai.fauxProvider({ models: modelDefinitions });
  modelRuntime.registerNativeProvider(faux.provider);

  const settingsManager = coding.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new coding.DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  const sessionManager = coding.SessionManager.create(workDir, sessionDir);
  const { session, extensionsResult } = await coding.createAgentSession({
    cwd: workDir,
    agentDir,
    model: modelRuntime.getModel("faux", modelId),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    noTools: "builtin",
  });

  const restore = () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  return {
    session,
    sessionManager,
    modelRuntime,
    faux,
    extensionsResult,
    ai,
    restore,
    host: await loadPiHost(),
    /** All tool definitions any loaded extension registered, by name. */
    toolDefinitions() {
      const definitions = new Map();
      for (const extension of extensionsResult.extensions || []) {
        for (const [name, registered] of extension.tools || []) definitions.set(name, registered.definition || registered);
      }
      return definitions;
    },
    dispose() {
      try {
        session.dispose();
      } finally {
        restore();
      }
    },
  };
}