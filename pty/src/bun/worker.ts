import { TerminalManager, type TerminalMessage } from "./terminalManager";

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type BaseTerminalParams = {
  __source?: InvocationSource;
  __viewerId?: string;
};

type CreateTerminalParams = BaseTerminalParams & {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
};

type TerminalActionParams = BaseTerminalParams & {
  terminalId?: string;
};

type WriteTerminalParams = TerminalActionParams & {
  data?: string;
};

type ResizeTerminalParams = TerminalActionParams & {
  cols?: number;
  rows?: number;
};

type HeartbeatTerminalsParams = BaseTerminalParams & {
  terminalIds?: unknown;
};

type WorkerRuntimeContext = {
  context?: {
    config?: {
      ptyHeartbeatTimeoutMs?: unknown;
      ptyHeartbeatSweepMs?: unknown;
      ptySessionIdleTimeoutMs?: unknown;
    };
  };
};

type SessionRecipient = {
  carrotId: string;
  windowId?: string | null;
  viewers: Map<string, number>;
};

type SharedTerminalSession = {
  terminalId: string;
  cwd: string;
  currentCwd: string;
  shell: string;
  createdAt: number;
  lastOutputAt: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  scrollback: string;
  recipients: Map<string, SessionRecipient>;
  lastDetachedAt: number | null;
};

type PtySessionSnapshot = {
  terminalId: string;
  cwd: string;
  currentCwd: string;
  shell: string;
  createdAt: number;
  lastOutputAt: number | null;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  viewerCount: number;
  scrollback?: string;
};

const DEFAULT_TERMINAL_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TERMINAL_HEARTBEAT_SWEEP_MS = 30 * 1000;
const DEFAULT_TERMINAL_SESSION_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_SCROLLBACK_CHARS = 200_000;

function parseDurationMs(
  value: unknown,
  fallback: number,
  minimum: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

let terminalHeartbeatTimeoutMs = parseDurationMs(
  process.env.BUNNY_PTY_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_TERMINAL_HEARTBEAT_TIMEOUT_MS,
  1_000,
);
let terminalHeartbeatSweepMs = parseDurationMs(
  process.env.BUNNY_PTY_HEARTBEAT_SWEEP_MS,
  DEFAULT_TERMINAL_HEARTBEAT_SWEEP_MS,
  250,
);
let terminalSessionIdleTimeoutMs = parseDurationMs(
  process.env.BUNNY_PTY_SESSION_IDLE_TIMEOUT_MS,
  DEFAULT_TERMINAL_SESSION_IDLE_TIMEOUT_MS,
  60_000,
);

const terminalSessions = new Map<string, SharedTerminalSession>();

function post(message: unknown) {
  self.postMessage(message);
}

function log(message: string) {
  post({
    type: "action",
    action: "log",
    payload: { message },
  });
}

function extractSource(params: { __source?: InvocationSource } | null | undefined) {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("PTY requests require a source carrot id");
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

function countSessionViewers(session: SharedTerminalSession) {
  let count = 0;
  for (const recipient of session.recipients.values()) {
    count += recipient.viewers.size;
  }
  return count;
}

function appendSessionScrollback(session: SharedTerminalSession, data: string) {
  if (!data) {
    return;
  }

  session.lastOutputAt = Date.now();
  session.scrollback += data;
  if (session.scrollback.length > MAX_SCROLLBACK_CHARS) {
    session.scrollback = session.scrollback.slice(
      session.scrollback.length - MAX_SCROLLBACK_CHARS,
    );
  }
}

function attachViewer(
  session: SharedTerminalSession,
  source: { carrotId: string; windowId?: string | null },
  viewerId: string,
) {
  const recipientKey = makeRecipientKey(source);
  let recipient = session.recipients.get(recipientKey);
  if (!recipient) {
    recipient = {
      carrotId: source.carrotId,
      windowId: source.windowId ?? null,
      viewers: new Map(),
    };
    session.recipients.set(recipientKey, recipient);
  }
  recipient.viewers.set(viewerId, Date.now());
  session.lastDetachedAt = null;
}

function detachViewer(
  session: SharedTerminalSession,
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

  if (session.recipients.size === 0) {
    session.lastDetachedAt = Date.now();
  }

  return true;
}

function refreshViewerLease(
  terminalId: string,
  source: { carrotId: string; windowId?: string | null },
  viewerId: string,
) {
  const session = terminalSessions.get(terminalId);
  if (!session) {
    return false;
  }

  const recipient = session.recipients.get(makeRecipientKey(source));
  if (!recipient || !recipient.viewers.has(viewerId)) {
    return false;
  }

  recipient.viewers.set(viewerId, Date.now());
  session.lastDetachedAt = null;
  return true;
}

async function buildSessionSnapshot(
  session: SharedTerminalSession,
  options?: { includeScrollback?: boolean },
): Promise<PtySessionSnapshot> {
  if (session.status === "running") {
    const currentCwd = await terminalManager.getTerminalCwd(session.terminalId);
    if (currentCwd) {
      session.currentCwd = currentCwd;
    }
  }

  return {
    terminalId: session.terminalId,
    cwd: session.cwd,
    currentCwd: session.currentCwd || session.cwd,
    shell: session.shell,
    createdAt: session.createdAt,
    lastOutputAt: session.lastOutputAt,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    viewerCount: countSessionViewers(session),
    ...(options?.includeScrollback ? { scrollback: session.scrollback } : {}),
  };
}

async function listSessionSnapshots() {
  const snapshots = await Promise.all(
    Array.from(terminalSessions.values()).map((session) =>
      buildSessionSnapshot(session),
    ),
  );
  return snapshots.sort((left, right) => {
    const leftTime = left.lastOutputAt || left.createdAt;
    const rightTime = right.lastOutputAt || right.createdAt;
    return rightTime - leftTime;
  });
}

function emitToSessionRecipients(
  session: SharedTerminalSession,
  name: string,
  payload?: unknown,
) {
  for (const recipient of session.recipients.values()) {
    emitToCarrotView(recipient.carrotId, name, payload, {
      windowId: recipient.windowId ?? null,
    });
  }
}

function handleTerminalMessage(message: TerminalMessage) {
  const session = terminalSessions.get(message.terminalId);
  if (!session) {
    log(`dropping terminal event for unknown session: ${message.terminalId}`);
    return;
  }

  if (message.type === "terminalOutput") {
    appendSessionScrollback(session, message.data);
    emitToSessionRecipients(session, "terminalOutput", {
      terminalId: message.terminalId,
      data: message.data,
    });
    return;
  }

  if (message.type === "terminalExit") {
    session.status = "exited";
    session.exitCode = message.exitCode;
    session.signal = message.signal ?? 0;
    session.lastOutputAt = Date.now();
    emitToSessionRecipients(session, "terminalExit", {
      terminalId: message.terminalId,
      exitCode: message.exitCode,
      signal: message.signal ?? 0,
    });
    log(`terminal exited ${message.terminalId}`);
    if (session.recipients.size === 0 && !session.lastDetachedAt) {
      session.lastDetachedAt = Date.now();
    }
  }
}

function sweepTerminalLeases() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [terminalId, session] of terminalSessions.entries()) {
    for (const [recipientKey, recipient] of session.recipients.entries()) {
      for (const [viewerId, lastHeartbeatAt] of recipient.viewers.entries()) {
        if (now - lastHeartbeatAt > terminalHeartbeatTimeoutMs) {
          recipient.viewers.delete(viewerId);
          cleanedCount += 1;
        }
      }

      if (recipient.viewers.size === 0) {
        session.recipients.delete(recipientKey);
      }
    }

    if (session.recipients.size === 0) {
      if (!session.lastDetachedAt) {
        session.lastDetachedAt = now;
      }
      if (now - session.lastDetachedAt > terminalSessionIdleTimeoutMs) {
        if (session.status === "running") {
          log(`idle timeout kill ${terminalId}`);
          terminalManager.killTerminal(terminalId);
        }
        terminalSessions.delete(terminalId);
      }
    } else {
      session.lastDetachedAt = null;
    }
  }

  return cleanedCount;
}

const terminalManager = new TerminalManager(handleTerminalMessage);
let heartbeatSweepTimer: ReturnType<typeof setInterval> | null = null;

function restartHeartbeatSweepTimer() {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
  }
  heartbeatSweepTimer = setInterval(sweepTerminalLeases, terminalHeartbeatSweepMs);
}

function initializeRuntimeContext(message?: WorkerRuntimeContext) {
  terminalHeartbeatTimeoutMs = parseDurationMs(
    message?.context?.config?.ptyHeartbeatTimeoutMs,
    terminalHeartbeatTimeoutMs,
    1_000,
  );
  terminalHeartbeatSweepMs = parseDurationMs(
    message?.context?.config?.ptyHeartbeatSweepMs,
    terminalHeartbeatSweepMs,
    250,
  );
  terminalSessionIdleTimeoutMs = parseDurationMs(
    message?.context?.config?.ptySessionIdleTimeoutMs,
    terminalSessionIdleTimeoutMs,
    60_000,
  );
  restartHeartbeatSweepTimer();
}

initializeRuntimeContext();

async function handleRequest(method: string, params: unknown) {
  switch (method) {
    case "createTerminal": {
      const request = (params ?? {}) as CreateTerminalParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      const cwd = String(request.cwd || process.cwd());
      const shell = typeof request.shell === "string" ? request.shell : undefined;
      const terminalId = terminalManager.createTerminal(
        cwd,
        shell,
        Number(request.cols || 80),
        Number(request.rows || 24),
      );
      const session: SharedTerminalSession = {
        terminalId,
        cwd,
        currentCwd: cwd,
        shell: shell || "",
        createdAt: Date.now(),
        lastOutputAt: null,
        status: "running",
        exitCode: null,
        signal: null,
        scrollback: "",
        recipients: new Map(),
        lastDetachedAt: null,
      };
      attachViewer(session, source, viewerId);
      terminalSessions.set(terminalId, session);
      log(`created terminal ${terminalId} for ${source.carrotId}`);
      return terminalId;
    }
    case "attachTerminal": {
      const request = (params ?? {}) as TerminalActionParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      const terminalId = String(request.terminalId || "");
      const session = terminalSessions.get(terminalId);
      if (!session) {
        throw new Error("Terminal session not found");
      }
      attachViewer(session, source, viewerId);
      return await buildSessionSnapshot(session, { includeScrollback: true });
    }
    case "detachTerminal": {
      const request = (params ?? {}) as TerminalActionParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      const session = terminalSessions.get(String(request.terminalId || ""));
      if (!session) {
        return false;
      }
      return detachViewer(session, source, viewerId);
    }
    case "listTerminalSessions":
      return await listSessionSnapshots();
    case "writeToTerminal": {
      const request = (params ?? {}) as WriteTerminalParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      refreshViewerLease(String(request.terminalId || ""), source, viewerId);
      return terminalManager.writeToTerminal(
        String(request.terminalId || ""),
        String(request.data || ""),
      );
    }
    case "resizeTerminal": {
      const request = (params ?? {}) as ResizeTerminalParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      refreshViewerLease(String(request.terminalId || ""), source, viewerId);
      return terminalManager.resizeTerminal(
        String(request.terminalId || ""),
        Number(request.cols || 80),
        Number(request.rows || 24),
      );
    }
    case "killTerminal": {
      const request = (params ?? {}) as TerminalActionParams;
      const terminalId = String(request.terminalId || "");
      log(`kill terminal ${terminalId}`);
      terminalSessions.delete(terminalId);
      return terminalManager.killTerminal(terminalId);
    }
    case "getTerminalCwd": {
      const request = (params ?? {}) as TerminalActionParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      refreshViewerLease(String(request.terminalId || ""), source, viewerId);
      const cwd = await terminalManager.getTerminalCwd(String(request.terminalId || ""));
      const session = terminalSessions.get(String(request.terminalId || ""));
      if (session && cwd) {
        session.currentCwd = cwd;
      }
      return cwd;
    }
    case "heartbeatTerminals": {
      const request = (params ?? {}) as HeartbeatTerminalsParams;
      const source = extractSource(request);
      const viewerId = extractViewerId(request, source);
      const terminalIds = Array.isArray(request.terminalIds)
        ? request.terminalIds.map((terminalId) => String(terminalId || "")).filter(Boolean)
        : [];
      let refreshedCount = 0;
      for (const terminalId of terminalIds) {
        if (refreshViewerLease(terminalId, source, viewerId)) {
          refreshedCount += 1;
        }
      }
      return { refreshedCount };
    }
    case "sweepExpiredTerminals":
      return {
        cleanedCount: sweepTerminalLeases(),
      };
    default:
      return undefined;
  }
}

self.addEventListener("message", async (event) => {
  const message = event.data as
    | {
        type?: string;
        requestId?: number;
        method?: string;
        params?: unknown;
      }
    | undefined;

  if (message?.type === "init") {
    initializeRuntimeContext(message as WorkerRuntimeContext);
    return;
  }

  if (!message || message.type !== "request" || typeof message.requestId !== "number") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
    if (payload === undefined) {
      post({
        type: "response",
        requestId: message.requestId,
        success: false,
        error: `Unknown method: ${String(message.method || "")}`,
      });
      return;
    }

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
});

process.on("exit", () => {
  if (heartbeatSweepTimer) {
    clearInterval(heartbeatSweepTimer);
  }
  terminalManager.cleanup();
  terminalSessions.clear();
});

self.postMessage({ type: "ready" });
