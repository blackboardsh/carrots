import { spawn } from "bun";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { app } from "electrobun/bun";

const LLAMA_BINARY_NAME = process.platform === "win32" ? "llama-cli.exe" : "llama-cli";
const MIN_MODEL_BYTES = 100 * 1024 * 1024;
const LLAMA_TIMEOUT_MS = 45_000;
const DEFAULT_DOWNLOAD_BASE_URL_TEMPLATE =
  "https://huggingface.co/{user}/{repo}/resolve/main/{filePath}";
const CHAT_SESSIONS_STATE_FILE = "chat-sessions.json";
const DEFAULT_CHAT_TITLE = "New Chat";

type LlamaCompletionOptions = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  repeat_penalty?: number;
  stop?: string[];
};

type DownloadStatus = {
  status: "downloading" | "completed" | "failed";
  progress: number;
  fileName: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
};

type WorkerRuntimeContext = {
  context?: {
    statePath?: unknown;
    config?: {
      llamaBinaryPath?: unknown;
      llamaModelsDir?: unknown;
      llamaMinModelBytes?: unknown;
      llamaTimeoutMs?: unknown;
      llamaDownloadBaseUrlTemplate?: unknown;
    };
  };
};

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type BaseChatParams = {
  __source?: InvocationSource;
  __viewerId?: string;
};

type SessionViewerRecipient = {
  carrotId: string;
  windowId?: string | null;
  viewers: Set<string>;
};

type LlamaChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  error?: boolean;
};

type PersistedLlamaChatSession = {
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  path?: string;
  options: LlamaCompletionOptions;
  messages: LlamaChatMessage[];
};

type SharedLlamaChatSession = PersistedLlamaChatSession & {
  recipients: Map<string, SessionViewerRecipient>;
};

type LlamaChatSessionSummary = {
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  viewerCount: number;
  lastMessagePreview: string;
  path?: string;
};

type LlamaChatSessionPayload = {
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  path?: string;
  options: LlamaCompletionOptions;
  messages: LlamaChatMessage[];
  viewerCount: number;
};

const activeProcesses = new Map<number, ReturnType<typeof spawn>>();
const modelDownloads = new Map<string, DownloadStatus>();
const chatSessions = new Map<string, SharedLlamaChatSession>();
let chatSessionsLoaded = false;
let llamaBinaryPathOverride: string | null = null;
let modelsDirOverride: string | null = null;
let statePathOverride: string | null = null;
let preparedDefaultModelsDir = false;
let minModelBytes = parsePositiveNumber(
  process.env.BUNNY_LLAMA_MIN_MODEL_BYTES,
  MIN_MODEL_BYTES,
  1,
);
let llamaTimeoutMs = parsePositiveNumber(
  process.env.BUNNY_LLAMA_TIMEOUT_MS,
  LLAMA_TIMEOUT_MS,
  1_000,
);
let downloadBaseUrlTemplate =
  process.env.BUNNY_LLAMA_DOWNLOAD_BASE_URL_TEMPLATE || DEFAULT_DOWNLOAD_BASE_URL_TEMPLATE;

function post(message: unknown) {
  self.postMessage(message);
}

function parsePositiveNumber(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function initializeRuntimeContext(message: WorkerRuntimeContext) {
  if (
    typeof message.context?.statePath === "string" &&
    message.context.statePath.length > 0
  ) {
    statePathOverride = message.context.statePath;
  }

  const config = message.context?.config;
  if (!config) {
    return;
  }

  if (typeof config.llamaBinaryPath === "string" && config.llamaBinaryPath.length > 0) {
    llamaBinaryPathOverride = config.llamaBinaryPath;
  }

  if (typeof config.llamaModelsDir === "string" && config.llamaModelsDir.length > 0) {
    modelsDirOverride = config.llamaModelsDir;
  }

  minModelBytes = parsePositiveNumber(config.llamaMinModelBytes, minModelBytes, 1);
  llamaTimeoutMs = parsePositiveNumber(config.llamaTimeoutMs, llamaTimeoutMs, 1_000);

  if (
    typeof config.llamaDownloadBaseUrlTemplate === "string" &&
    config.llamaDownloadBaseUrlTemplate.length > 0
  ) {
    downloadBaseUrlTemplate = config.llamaDownloadBaseUrlTemplate;
  }
}

function getDefaultModelsDir() {
  return join(homedir(), ".dash", "models");
}

function getResolvedStatePath() {
  return statePathOverride || app.statePath || join(import.meta.dir, "state.json");
}

function getStateDir() {
  const stateDir = dirname(getResolvedStatePath());
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  return stateDir;
}

function getChatSessionsStatePath() {
  return join(getStateDir(), CHAT_SESSIONS_STATE_FILE);
}

function getLegacyModelsDir() {
  return join(getStateDir(), "models");
}

function migrateLegacyModelsToDefaultDir(defaultModelsDir: string) {
  if (preparedDefaultModelsDir) {
    return;
  }
  preparedDefaultModelsDir = true;

  const legacyModelsDir = getLegacyModelsDir();
  if (
    !legacyModelsDir ||
    legacyModelsDir === defaultModelsDir ||
    !existsSync(legacyModelsDir)
  ) {
    return;
  }

  const legacyFiles = readdirSync(legacyModelsDir).filter((file) =>
    file.endsWith(".gguf"),
  );

  for (const file of legacyFiles) {
    const sourcePath = join(legacyModelsDir, file);
    const destinationPath = join(defaultModelsDir, file);

    if (existsSync(destinationPath)) {
      continue;
    }

    try {
      renameSync(sourcePath, destinationPath);
    } catch {
      copyFileSync(sourcePath, destinationPath);
      try {
        unlinkSync(sourcePath);
      } catch {
        // Best effort cleanup after copy fallback.
      }
    }
  }
}

function getModelsDir() {
  const modelsDir = modelsDirOverride || getDefaultModelsDir();
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true });
  }
  if (!modelsDirOverride) {
    migrateLegacyModelsToDefaultDir(modelsDir);
  }
  return modelsDir;
}

function getLlamaCliPath() {
  const candidates = [
    llamaBinaryPathOverride,
    process.env.BUNNY_LLAMA_CLI_BIN,
    join(import.meta.dir, LLAMA_BINARY_NAME),
    join(process.cwd(), "carrots", "llama", "llama-cli", "zig-out", "bin", LLAMA_BINARY_NAME),
    join(process.cwd(), "llama-cli", "zig-out", "bin", LLAMA_BINARY_NAME),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  const binaryPath = candidates.find((candidate) => existsSync(candidate));
  if (!binaryPath) {
    throw new Error(
      [
        "Missing runnable llama-cli binary for bunny.llama.",
        `Searched: ${candidates.join(", ")}`,
        "Build and bundle carrots/llama/llama-cli, or set BUNNY_LLAMA_CLI_BIN to a runnable llama-cli path.",
      ].join(" "),
    );
  }
  return binaryPath;
}

function resolveDownloadUrl(user: string, repo: string, filePath: string) {
  return downloadBaseUrlTemplate
    .replaceAll("{user}", user)
    .replaceAll("{repo}", repo)
    .replaceAll("{filePath}", filePath)
    .replaceAll("{fileName}", basename(filePath));
}

function killActiveCompletions() {
  for (const proc of activeProcesses.values()) {
    try {
      proc.kill();
    } catch {
      // Ignore already-dead processes.
    }
  }
  activeProcesses.clear();
}

function resolveModelPath(model: string) {
  const modelsDir = getModelsDir();
  const candidates = [
    join(modelsDir, model),
    join(modelsDir, model.endsWith(".gguf") ? model : `${model}.gguf`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function emitToCarrotView(
  carrotId: string,
  name: string,
  payload?: unknown,
  options?: { windowId?: string | null },
) {
  post({
    type: "action",
    action: "emit-carrot-view-event",
    payload: {
      carrotId,
      name,
      payload,
      raw: true,
      windowId: options?.windowId ?? null,
    },
  });
}

function emitAgentSessionsChanged() {
  emitToCarrotView("dash-ui", "agentSessionsChanged", {}, { windowId: null });
}

function emitAgentSessionUpdated(session: SharedLlamaChatSession) {
  const payload = {
    session: buildSessionPayload(session),
  };
  for (const recipient of session.recipients.values()) {
    emitToCarrotView(recipient.carrotId, "agentSessionUpdated", payload, {
      windowId: recipient.windowId ?? null,
    });
  }
}

function emitAgentSessionDeleted(sessionId: string) {
  emitToCarrotView("dash-ui", "agentSessionDeleted", { sessionId }, { windowId: null });
}

function extractSource(params: { __source?: InvocationSource } | null | undefined) {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("Llama chat requests require a source carrot id");
  }

  return {
    carrotId,
    windowId: params?.__source?.windowId ?? null,
  };
}

function extractViewerId(
  params: { __viewerId?: string } | null | undefined,
  source: { carrotId: string; windowId?: string | null },
) {
  return String(
    params?.__viewerId ||
      source.windowId ||
      `${source.carrotId}:default`,
  ).trim();
}

function makeRecipientKey(source: { carrotId: string; windowId?: string | null }) {
  return `${source.carrotId}:${source.windowId || ""}`;
}

function countSessionViewers(session: SharedLlamaChatSession) {
  let count = 0;
  for (const recipient of session.recipients.values()) {
    count += recipient.viewers.size;
  }
  return count;
}

function attachViewer(
  session: SharedLlamaChatSession,
  source: { carrotId: string; windowId?: string | null },
  viewerId: string,
) {
  const recipientKey = makeRecipientKey(source);
  let recipient = session.recipients.get(recipientKey);
  if (!recipient) {
    recipient = {
      carrotId: source.carrotId,
      windowId: source.windowId ?? null,
      viewers: new Set<string>(),
    };
    session.recipients.set(recipientKey, recipient);
  }
  recipient.viewers.add(viewerId);
}

function detachViewer(
  session: SharedLlamaChatSession,
  source: { carrotId: string; windowId?: string | null },
  viewerId: string,
) {
  const recipientKey = makeRecipientKey(source);
  const recipient = session.recipients.get(recipientKey);
  if (!recipient) {
    return false;
  }

  recipient.viewers.delete(viewerId);
  if (recipient.viewers.size === 0) {
    session.recipients.delete(recipientKey);
  }

  return true;
}

function normalizeCompletionOptions(
  options?: LlamaCompletionOptions,
  fallback?: LlamaCompletionOptions,
) {
  const base = fallback || {};
  const next = options || {};
  return {
    temperature:
      typeof next.temperature === "number"
        ? next.temperature
        : typeof base.temperature === "number"
          ? base.temperature
          : 0.7,
    top_p:
      typeof next.top_p === "number"
        ? next.top_p
        : typeof base.top_p === "number"
          ? base.top_p
          : 0.9,
    max_tokens:
      typeof next.max_tokens === "number"
        ? next.max_tokens
        : typeof base.max_tokens === "number"
          ? base.max_tokens
          : 2000,
    repeat_penalty:
      typeof next.repeat_penalty === "number"
        ? next.repeat_penalty
        : typeof base.repeat_penalty === "number"
          ? base.repeat_penalty
          : 1.1,
    stop: Array.isArray(next.stop)
      ? next.stop.filter((item): item is string => typeof item === "string")
      : Array.isArray(base.stop)
        ? base.stop.filter((item): item is string => typeof item === "string")
        : undefined,
  };
}

function createMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

function createSessionId() {
  return createMessageId();
}

function sanitizeSessionTitle(value: unknown) {
  const title = String(value || "").trim();
  return title || DEFAULT_CHAT_TITLE;
}

function buildSessionSummary(session: SharedLlamaChatSession): LlamaChatSessionSummary {
  const lastMessage = session.messages[session.messages.length - 1];
  return {
    sessionId: session.sessionId,
    title: session.title,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    viewerCount: countSessionViewers(session),
    lastMessagePreview: String(lastMessage?.content || "").slice(0, 120),
    path: session.path,
  };
}

function buildSessionPayload(session: SharedLlamaChatSession): LlamaChatSessionPayload {
  return {
    sessionId: session.sessionId,
    title: session.title,
    model: session.model,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    path: session.path,
    options: normalizeCompletionOptions(session.options),
    messages: session.messages.map((message) => ({ ...message })),
    viewerCount: countSessionViewers(session),
  };
}

function loadPersistedChatSessions() {
  if (chatSessionsLoaded) {
    return;
  }
  chatSessionsLoaded = true;
  chatSessions.clear();

  const sessionsPath = getChatSessionsStatePath();
  if (!existsSync(sessionsPath)) {
    return;
  }

  try {
    const raw = readFileSync(sessionsPath, "utf8");
    if (!raw.trim()) {
      return;
    }

    const parsed = JSON.parse(raw) as {
      v?: number;
      sessions?: PersistedLlamaChatSession[];
    };
    const persistedSessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];

    for (const persistedSession of persistedSessions) {
      const sessionId = String(persistedSession?.sessionId || "").trim();
      if (!sessionId) {
        continue;
      }

      chatSessions.set(sessionId, {
        sessionId,
        title: sanitizeSessionTitle(persistedSession.title),
        model: String(persistedSession.model || "").trim(),
        createdAt: Number(persistedSession.createdAt || Date.now()),
        updatedAt: Number(persistedSession.updatedAt || Date.now()),
        path: String(persistedSession.path || "").trim() || undefined,
        options: normalizeCompletionOptions(persistedSession.options),
        messages: Array.isArray(persistedSession.messages)
          ? persistedSession.messages
              .map((message) => ({
                id: String(message?.id || createMessageId()),
                role: message?.role === "assistant" ? "assistant" : "user",
                content: String(message?.content || ""),
                timestamp: Number(message?.timestamp || Date.now()),
                ...(message?.error ? { error: true } : {}),
              }))
              .filter((message) => message.content.length > 0)
          : [],
        recipients: new Map(),
      });
    }
  } catch {
    // Ignore corrupt chat-session state for now and start clean.
  }
}

function persistChatSessions() {
  loadPersistedChatSessions();
  const sessionsPath = getChatSessionsStatePath();
  const payload = {
    v: 1,
    sessions: Array.from(chatSessions.values()).map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.path ? { path: session.path } : {}),
      options: normalizeCompletionOptions(session.options),
      messages: session.messages,
    })),
  };
  writeFileSync(sessionsPath, JSON.stringify(payload, null, 2));
}

function getChatSession(sessionId: string) {
  loadPersistedChatSessions();
  return chatSessions.get(sessionId) || null;
}

function listChatSessionSummaries() {
  loadPersistedChatSessions();
  return Array.from(chatSessions.values())
    .map((session) => buildSessionSummary(session))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function generateChatTitle(content: string) {
  const words = String(content || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) {
    return DEFAULT_CHAT_TITLE;
  }
  const truncated = String(content || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length > 4;
  return `${words.join(" ")}${truncated ? "..." : ""}`;
}

function buildFriendlyCompletionErrorMessage(error: string) {
  if (error.includes("Missing runnable llama-cli") || error.includes("Missing bundled llama-cli")) {
    return "Sorry, this instance does not have a runnable llama-cli binary yet. Build or configure bunny.llama on that instance, then try again.";
  }
  if (error.includes("Model not found")) {
    return "Sorry, the selected local AI model is not installed on this instance.";
  }
  return "Sorry, I encountered an error while generating a response. Please make sure your local AI model is running.";
}

function buildConversationPrompt(
  session: SharedLlamaChatSession,
  contextPrompt?: string,
) {
  const normalizedContext = String(contextPrompt || "").trim();
  let systemPrompt = "You are a helpful AI assistant.";
  if (normalizedContext) {
    systemPrompt += ` Here is your custom context and instructions:\n\n${normalizedContext}\n\nPlease follow these instructions while being helpful and responsive.`;
  }

  const promptMessages = session.messages
    .filter((message) => !message.error)
    .slice(-6);

  let prompt = `${systemPrompt}\n\n`;
  for (const message of promptMessages) {
    prompt += `${message.role === "user" ? "User" : "Assistant"}: ${message.content}\n\n`;
  }
  prompt += "Assistant:";
  return prompt;
}

async function runLlamaCompletion(params: {
  model?: string;
  prompt?: string;
  options?: LlamaCompletionOptions;
}) {
  killActiveCompletions();

  const modelName = String(params.model || "");
  const prompt = String(params.prompt || "");
  const modelPath = resolveModelPath(modelName);
  if (!modelPath) {
    return {
      ok: false,
      error: `Model not found: ${modelName}`,
    };
  }

  const normalizedOptions = normalizeCompletionOptions(params.options, {
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 48,
    repeat_penalty: 1.1,
  });

  const args = [
    "--model",
    modelPath,
    "--prompt",
    prompt,
    "--temperature",
    String(normalizedOptions.temperature || 0.7),
    "--n-predict",
    String(normalizedOptions.max_tokens || 48),
    "--top-p",
    String(normalizedOptions.top_p || 0.95),
    "--repeat-penalty",
    String(normalizedOptions.repeat_penalty || 1.1),
    "--quiet",
  ];

  const proc = spawn([getLlamaCliPath(), ...args], {
    stdout: "pipe",
    stderr: "ignore",
    // @ts-ignore Bun-specific custom binary flag
    allowUnsafeCustomBinary: true,
  });

  const requestId = Date.now() + Math.random();
  activeProcesses.set(requestId, proc);

  try {
    await Promise.race([
      proc.exited,
      new Promise((_, reject) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // Ignore kill failures.
          }
          reject(new Error("llama-cli completion timeout"));
        }, llamaTimeoutMs),
      ),
    ]);

    activeProcesses.delete(requestId);

    if (proc.exitCode !== 0) {
      return {
        ok: false,
        error: `llama-cli process failed with exit code ${proc.exitCode}`,
      };
    }

    const stdout = await new Response(proc.stdout).text();
    return {
      ok: true,
      response: stdout.trim(),
    };
  } catch (error) {
    activeProcesses.delete(requestId);
    try {
      proc.kill();
    } catch {
      // Ignore kill failures.
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function llamaCompletion(params: {
  model?: string;
  prompt?: string;
  options?: LlamaCompletionOptions;
}) {
  return runLlamaCompletion(params);
}

async function llamaListModels() {
  try {
    const modelsDir = getModelsDir();
    const models = readdirSync(modelsDir)
      .filter((file) => file.endsWith(".gguf"))
      .map((file) => {
        const filePath = join(modelsDir, file);
        const stats = statSync(filePath);
        return {
          name: file.replace(/\.gguf$/i, ""),
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          source: "llama" as const,
        };
      })
      .filter((model) => model.size > minModelBytes)
      .sort((a, b) => b.modified.localeCompare(a.modified));

    return {
      ok: true,
      models,
    };
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function llamaCreateChatSession(
  params: BaseChatParams & {
    title?: string;
    model?: string;
    options?: LlamaCompletionOptions;
    path?: string;
  },
) {
  loadPersistedChatSessions();
  const sessionId = createSessionId();
  const now = Date.now();
  const session: SharedLlamaChatSession = {
    sessionId,
    title: sanitizeSessionTitle(params.title),
    model: String(params.model || "").trim(),
    createdAt: now,
    updatedAt: now,
    path: String(params.path || "").trim() || undefined,
    options: normalizeCompletionOptions(params.options),
    messages: [],
    recipients: new Map(),
  };

  chatSessions.set(sessionId, session);
  persistChatSessions();
  emitAgentSessionsChanged();
  emitAgentSessionUpdated(session);

  return {
    ok: true,
    session: buildSessionPayload(session),
  };
}

async function llamaAttachChatSession(
  params: BaseChatParams & {
    sessionId?: string;
  },
) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  const source = extractSource(params);
  const viewerId = extractViewerId(params, source);
  attachViewer(session, source, viewerId);
  emitAgentSessionsChanged();

  return {
    ok: true,
    session: buildSessionPayload(session),
  };
}

async function llamaDetachChatSession(
  params: BaseChatParams & {
    sessionId?: string;
  },
) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  const source = extractSource(params);
  const viewerId = extractViewerId(params, source);
  const detached = detachViewer(session, source, viewerId);
  if (detached) {
    emitAgentSessionsChanged();
  }

  return {
    ok: detached,
  };
}

async function llamaListChatSessions() {
  return {
    ok: true,
    sessions: listChatSessionSummaries(),
  };
}

async function llamaGetChatSession(params: { sessionId?: string }) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  return {
    ok: true,
    session: buildSessionPayload(session),
  };
}

async function llamaUpdateChatSession(
  params: BaseChatParams & {
    sessionId?: string;
    title?: string;
    model?: string;
    options?: LlamaCompletionOptions;
    path?: string;
  },
) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  if (typeof params.title === "string") {
    session.title = sanitizeSessionTitle(params.title);
  }
  if (typeof params.model === "string" && params.model.trim()) {
    session.model = params.model.trim();
  }
  if (params.options) {
    session.options = normalizeCompletionOptions(params.options, session.options);
  }
  if (typeof params.path === "string") {
    session.path = params.path.trim() || undefined;
  }
  session.updatedAt = Date.now();

  persistChatSessions();
  emitAgentSessionsChanged();
  emitAgentSessionUpdated(session);

  return {
    ok: true,
    session: buildSessionPayload(session),
  };
}

async function llamaDeleteChatSession(params: { sessionId?: string }) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  chatSessions.delete(sessionId);
  persistChatSessions();
  emitAgentSessionsChanged();
  emitAgentSessionDeleted(sessionId);

  return {
    ok: true,
  };
}

async function llamaSendChatMessage(
  params: BaseChatParams & {
    sessionId?: string;
    content?: string;
    contextPrompt?: string;
    model?: string;
    options?: LlamaCompletionOptions;
    path?: string;
  },
) {
  const sessionId = String(params.sessionId || "").trim();
  const session = getChatSession(sessionId);
  if (!session) {
    return {
      ok: false,
      error: "Chat session not found",
    };
  }

  if (params.__source) {
    const source = extractSource(params);
    const viewerId = extractViewerId(params, source);
    attachViewer(session, source, viewerId);
  }

  const content = String(params.content || "").trim();
  if (!content) {
    return {
      ok: false,
      error: "Message content is required",
      session: buildSessionPayload(session),
    };
  }

  if (typeof params.model === "string" && params.model.trim()) {
    session.model = params.model.trim();
  }
  if (params.options) {
    session.options = normalizeCompletionOptions(params.options, session.options);
  }
  if (typeof params.path === "string") {
    session.path = params.path.trim() || undefined;
  }

  const userMessage: LlamaChatMessage = {
    id: createMessageId(),
    role: "user",
    content,
    timestamp: Date.now(),
  };
  session.messages.push(userMessage);
  if (
    session.title === DEFAULT_CHAT_TITLE &&
    session.messages.filter((message) => message.role === "user").length === 1
  ) {
    session.title = generateChatTitle(content);
  }
  session.updatedAt = Date.now();
  persistChatSessions();
  emitAgentSessionsChanged();
  emitAgentSessionUpdated(session);

  if (!session.model) {
    const error = "No model selected";
    const assistantMessage: LlamaChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: buildFriendlyCompletionErrorMessage(error),
      timestamp: Date.now(),
      error: true,
    };
    session.messages.push(assistantMessage);
    session.updatedAt = Date.now();
    persistChatSessions();
    emitAgentSessionsChanged();
    emitAgentSessionUpdated(session);
    return {
      ok: false,
      error,
      session: buildSessionPayload(session),
    };
  }

  const completion = await runLlamaCompletion({
    model: session.model,
    prompt: buildConversationPrompt(session, params.contextPrompt),
    options: session.options,
  });

  if (!completion.ok || !completion.response) {
    const error = String(completion.error || "Unknown llama completion error");
    const assistantMessage: LlamaChatMessage = {
      id: createMessageId(),
      role: "assistant",
      content: buildFriendlyCompletionErrorMessage(error),
      timestamp: Date.now(),
      error: true,
    };
    session.messages.push(assistantMessage);
    session.updatedAt = Date.now();
    persistChatSessions();
    emitAgentSessionsChanged();
    emitAgentSessionUpdated(session);
    return {
      ok: false,
      error,
      session: buildSessionPayload(session),
    };
  }

  const assistantMessage: LlamaChatMessage = {
    id: createMessageId(),
    role: "assistant",
    content: completion.response.trim(),
    timestamp: Date.now(),
  };
  session.messages.push(assistantMessage);
  session.updatedAt = Date.now();
  persistChatSessions();
  emitAgentSessionsChanged();
  emitAgentSessionUpdated(session);

  return {
    ok: true,
    response: assistantMessage.content,
    session: buildSessionPayload(session),
  };
}

async function llamaInstallModel(params: { modelRef?: string }) {
  const modelRef = String(params.modelRef || "");
  if (!modelRef.startsWith("hf://")) {
    return {
      ok: false,
      error: "Only Hugging Face models (hf://) are supported",
    };
  }

  const hfPath = modelRef.slice(5);
  const pathParts = hfPath.split("/");
  if (pathParts.length < 3) {
    return {
      ok: false,
      error: "Invalid Hugging Face model reference",
    };
  }

  const [user, repo, ...fileParts] = pathParts;
  const fileName = fileParts.join("/");
  const localFileName = basename(fileName);
  const localFilePath = join(getModelsDir(), localFileName);

  if (existsSync(localFilePath)) {
    const stats = statSync(localFilePath);
    if (stats.size > minModelBytes) {
      return { ok: true, message: "Model already downloaded" };
    }
  }

  const downloadUrl = resolveDownloadUrl(user, repo, fileName);
  const downloadId = `${user}-${repo}-${localFileName}`;

  void (async () => {
    modelDownloads.set(downloadId, {
      status: "downloading",
      progress: 0,
      fileName: localFileName,
    });

    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
      const fileStream = Bun.file(localFilePath).writer();
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      let downloadedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        await fileStream.write(value);
        downloadedBytes += value.byteLength;

        modelDownloads.set(downloadId, {
          status: "downloading",
          progress: totalBytes > 0 ? Math.floor((downloadedBytes / totalBytes) * 100) : 0,
          fileName: localFileName,
          downloadedBytes,
          totalBytes,
        });
      }

      await fileStream.end();

      const stats = statSync(localFilePath);
      if (stats.size <= minModelBytes) {
        unlinkSync(localFilePath);
        throw new Error(`Download failed - file too small (${stats.size} bytes)`);
      }

      modelDownloads.set(downloadId, {
        status: "completed",
        progress: 100,
        fileName: localFileName,
        downloadedBytes: stats.size,
        totalBytes: stats.size,
      });
    } catch (error) {
      if (existsSync(localFilePath)) {
        try {
          unlinkSync(localFilePath);
        } catch {
          // Ignore cleanup failures.
        }
      }

      modelDownloads.set(downloadId, {
        status: "failed",
        progress: 0,
        fileName: localFileName,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  })();

  return {
    ok: true,
    downloading: true,
    downloadId,
  };
}

async function llamaDownloadStatus(params: { downloadId?: string }) {
  if (params.downloadId) {
    return {
      ok: true,
      status: modelDownloads.get(String(params.downloadId || "")),
    };
  }

  const downloads: Record<string, DownloadStatus> = {};
  for (const [downloadId, status] of modelDownloads.entries()) {
    downloads[downloadId] = status;
  }

  return {
    ok: true,
    downloads,
  };
}

async function llamaRemoveModel(params: { modelPath?: string }) {
  const modelPath = String(params.modelPath || "");
  try {
    if (!existsSync(modelPath)) {
      return {
        ok: false,
        error: "Model file not found",
      };
    }

    unlinkSync(modelPath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to remove model",
    };
  }
}

async function handleRequest(method: string, params: any) {
  switch (method) {
    case "llamaCompletion":
      return llamaCompletion(params ?? {});
    case "llamaListModels":
      return llamaListModels();
    case "llamaCreateChatSession":
      return llamaCreateChatSession(params ?? {});
    case "llamaAttachChatSession":
      return llamaAttachChatSession(params ?? {});
    case "llamaDetachChatSession":
      return llamaDetachChatSession(params ?? {});
    case "llamaListChatSessions":
      return llamaListChatSessions();
    case "llamaGetChatSession":
      return llamaGetChatSession(params ?? {});
    case "llamaUpdateChatSession":
      return llamaUpdateChatSession(params ?? {});
    case "llamaDeleteChatSession":
      return llamaDeleteChatSession(params ?? {});
    case "llamaSendChatMessage":
      return llamaSendChatMessage(params ?? {});
    case "llamaInstallModel":
      return llamaInstallModel(params ?? {});
    case "llamaDownloadStatus":
      return llamaDownloadStatus(params ?? {});
    case "llamaRemoveModel":
      return llamaRemoveModel(params ?? {});
    default:
      return undefined;
  }
}

process.on("exit", () => {
  killActiveCompletions();
});

self.onmessage = async (event) => {
  const message = event.data as {
    type?: string;
    requestId?: number;
    method?: string;
    params?: unknown;
  } | undefined;

  if (message?.type === "init") {
    initializeRuntimeContext(message as WorkerRuntimeContext);
    loadPersistedChatSessions();
    return;
  }

  if (!message || message.type !== "request") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
    post({
      type: "response",
      requestId: message.requestId,
      success: true,
      payload,
    });
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

self.postMessage({ type: "ready" });
