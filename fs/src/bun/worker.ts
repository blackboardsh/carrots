import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Carrots } from "electrobun/bun";

type InvocationSource = {
  carrotId?: string;
  windowId?: string | null;
};

type SearchTarget = {
  projectId: string;
  path: string;
};

type SearchRequestParams = {
  query?: string;
  targets?: SearchTarget[];
  __source?: InvocationSource;
};

type CancelSearchParams = {
  __source?: InvocationSource;
};

type FindFirstNestedGitRepoParams = {
  searchPath?: string;
  timeoutMs?: number;
};

type SearchOwner = {
  carrotId: string;
  windowId?: string | null;
  key: string;
};

type FindAllResult = {
  path: string;
  line: number;
  column: number;
  match: string;
};

type SearchSession<T> = {
  owner: SearchOwner;
  processes: Subprocess[];
  resultBatches: Map<string, T[]>;
  batchTimeout: ReturnType<typeof setTimeout> | null;
  totalResultCount: number;
};

type FileWatchTarget = {
  watchId: string;
  workspaceId?: string | null;
  path: string;
};

type ProjectDirectoryWatcher = {
  close: () => void;
};

type FileReadResponse = {
  textContent: string;
  isBinary: boolean;
  loadedBytes: number;
  totalBytes: number;
};

const ACTIVE_SLATE_CONFIG_FILE = ".bunny.json";
const FD_BINARY_NAME = process.platform === "win32" ? "fd.exe" : "fd";
const RG_BINARY_NAME = process.platform === "win32" ? "rg.exe" : "rg";
const SEARCH_BATCH_FLUSH_MS = 100;
const MAX_FIND_ALL_RESULTS = 1_000;
const MAX_FIND_FILES_RESULTS = 500;
const workerDir = dirname(fileURLToPath(import.meta.url));
const FD_BINARY_PATH = resolveBinary([
  process.env.BUNNY_FS_FD_PATH || "",
  join(workerDir, FD_BINARY_NAME),
  Bun.which("fd") || "",
  Bun.which("fdfind") || "",
]);
const RG_BINARY_PATH = resolveBinary([
  process.env.BUNNY_FS_RG_PATH || "",
  join(workerDir, RG_BINARY_NAME),
  Bun.which("rg") || "",
]);
const GREP_BINARY_PATH = Bun.which("grep");

const findAllSessions = new Map<string, SearchSession<FindAllResult>>();
const findFilesSessions = new Map<string, SearchSession<string>>();
const watchedProjects = new Map<string, FileWatchTarget>();
const directoryWatchers = new Map<string, ProjectDirectoryWatcher>();
let watchOwnerCarrotId: string | null = null;

const WATCH_IGNORED_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".turbo",
  "artifacts",
  "build",
  "dist",
  "node_modules",
]);

function resolveBinary(candidates: string[]) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function post(message: unknown) {
  self.postMessage(message);
}

function extractSource(params: { __source?: InvocationSource } | null | undefined): SearchOwner {
  const carrotId = params?.__source?.carrotId;
  if (!carrotId) {
    throw new Error("FS requests require a source carrot id");
  }

  const windowId = params?.__source?.windowId ?? null;
  return {
    carrotId,
    windowId,
    key: `${carrotId}::${windowId ?? "__global__"}`,
  };
}

function clearBatchTimeout<T>(session: SearchSession<T>) {
  if (!session.batchTimeout) {
    return;
  }
  clearTimeout(session.batchTimeout);
  session.batchTimeout = null;
}

function stopProcesses(processes: Subprocess[]) {
  for (const process of processes) {
    try {
      process.kill();
    } catch {
      // Ignore shutdown failures for already-exited child processes.
    }
  }
}

function cancelSession<T>(sessions: Map<string, SearchSession<T>>, key: string) {
  const session = sessions.get(key);
  if (!session) {
    return false;
  }

  clearBatchTimeout(session);
  stopProcesses(session.processes);
  sessions.delete(key);
  return true;
}

function cancelAllSessions() {
  for (const key of Array.from(findAllSessions.keys())) {
    cancelSession(findAllSessions, key);
  }
  for (const key of Array.from(findFilesSessions.keys())) {
    cancelSession(findFilesSessions, key);
  }
}

function closeAllDirectoryWatchers() {
  for (const watcher of directoryWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // Ignore cleanup failures.
    }
  }
  directoryWatchers.clear();
}

function createSearchSession<T>(owner: SearchOwner) {
  return {
    owner,
    processes: [],
    resultBatches: new Map<string, T[]>(),
    batchTimeout: null,
    totalResultCount: 0,
  } satisfies SearchSession<T>;
}

function readProcessLines(process: Subprocess, onLine: (line: string) => void) {
  const reader = process.stdout.getReader();
  let stdoutBuffer = "";

  async function readStream() {
    try {
      const { done, value } = await reader.read();
      if (value) {
        stdoutBuffer += new TextDecoder().decode(value);
        const lines = stdoutBuffer.split("\n");
        for (let index = 0; index < lines.length - 1; index += 1) {
          if (lines[index]) {
            onLine(lines[index]!);
          }
        }
        stdoutBuffer = lines[lines.length - 1] || "";
      }

      if (!done) {
        void readStream();
        return;
      }

      if (stdoutBuffer.length > 0) {
        onLine(stdoutBuffer);
      }
    } catch {
      // Ignore reader shutdown after process cancellation.
    }
  }

  void readStream();
}

function emitFindAllResults(owner: SearchOwner, query: string, projectId: string, results: FindAllResult[]) {
  if (results.length === 0) {
    return;
  }

  Carrots.emit(owner.carrotId, "fs-find-all-results", {
    windowId: owner.windowId ?? null,
    query,
    projectId,
    results,
  });
}

function emitFindFileResults(owner: SearchOwner, query: string, projectId: string, results: string[]) {
  if (results.length === 0) {
    return;
  }

  Carrots.emit(owner.carrotId, "fs-find-files-results", {
    windowId: owner.windowId ?? null,
    query,
    projectId,
    results,
  });
}

function flushFindAllBatches(session: SearchSession<FindAllResult>, query: string) {
  clearBatchTimeout(session);
  for (const [projectId, results] of session.resultBatches.entries()) {
    if (results.length === 0) {
      continue;
    }
    emitFindAllResults(session.owner, query, projectId, [...results]);
    results.length = 0;
  }
}

function scheduleFindAllFlush(session: SearchSession<FindAllResult>, query: string) {
  clearBatchTimeout(session);
  session.batchTimeout = setTimeout(() => {
    flushFindAllBatches(session, query);
  }, SEARCH_BATCH_FLUSH_MS);
}

function flushFindFileBatches(session: SearchSession<string>, query: string) {
  clearBatchTimeout(session);
  for (const [projectId, results] of session.resultBatches.entries()) {
    if (results.length === 0) {
      continue;
    }
    emitFindFileResults(session.owner, query, projectId, [...results]);
    results.length = 0;
  }
}

function scheduleFindFileFlush(session: SearchSession<string>, query: string) {
  clearBatchTimeout(session);
  session.batchTimeout = setTimeout(() => {
    flushFindFileBatches(session, query);
  }, SEARCH_BATCH_FLUSH_MS);
}

function createFindAllProcess(path: string, query: string) {
  if (RG_BINARY_PATH) {
    return Bun.spawn(
      [
        RG_BINARY_PATH,
        "--line-number",
        "--column",
        "--no-heading",
        "--color=never",
        "--case-sensitive",
        "--max-count=500",
        query,
        path,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  if (GREP_BINARY_PATH) {
    return Bun.spawn(
      [
        GREP_BINARY_PATH,
        "-RIn",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "--exclude-dir=build",
        "--exclude-dir=dist",
        "--",
        query,
        path,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  throw new Error("Missing rg or grep binary. Install ripgrep or add a bundled vendor binary.");
}

function createFindFilesProcess(path: string, query: string) {
  const fuzzyPattern = query.split("").join(".*");

  if (FD_BINARY_PATH) {
    return Bun.spawn(
      [
        FD_BINARY_PATH,
        "--type",
        "f",
        "--hidden",
        "--exclude",
        ".git",
        "--full-path",
        fuzzyPattern,
        path,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  }

  return Bun.spawn(
    [
      "find",
      path,
      "-type",
      "f",
      "-not",
      "-path",
      "*/.git/*",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/build/*",
      "-not",
      "-path",
      "*/dist/*",
      "-iregex",
      `.*${fuzzyPattern}.*`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function startFindAllSearch(owner: SearchOwner, query: string, targets: SearchTarget[]) {
  cancelSession(findAllSessions, owner.key);

  const session = createSearchSession<FindAllResult>(owner);
  findAllSessions.set(owner.key, session);

  for (const target of targets) {
    const process = createFindAllProcess(target.path, query);
    session.processes.push(process);
    session.resultBatches.set(target.projectId, []);

    readProcessLines(process, (line) => {
      if (findAllSessions.get(owner.key) !== session) {
        return;
      }

      if (session.totalResultCount >= MAX_FIND_ALL_RESULTS) {
        cancelSession(findAllSessions, owner.key);
        return;
      }

      const parts = line.split(":");
      if (parts.length < 3) {
        return;
      }

      const hasColumn = parts.length >= 4 && Number.isFinite(Number(parts[2]));
      const result = {
        path: parts[0]!,
        line: Number(parts[1] || 0),
        column: hasColumn ? Number(parts[2] || 0) : 0,
        match: parts.slice(hasColumn ? 3 : 2).join(":"),
      } satisfies FindAllResult;

      const batch = session.resultBatches.get(target.projectId);
      if (!batch) {
        return;
      }

      batch.push(result);
      session.totalResultCount += 1;

      if (batch.length === 1 && !session.batchTimeout) {
        emitFindAllResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      if (batch.length >= 50) {
        emitFindAllResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      scheduleFindAllFlush(session, query);
    });
  }
}

function startFindFileSearch(owner: SearchOwner, query: string, targets: SearchTarget[]) {
  cancelSession(findFilesSessions, owner.key);

  const session = createSearchSession<string>(owner);
  findFilesSessions.set(owner.key, session);

  for (const target of targets) {
    const process = createFindFilesProcess(target.path, query);
    session.processes.push(process);
    session.resultBatches.set(target.projectId, []);

    readProcessLines(process, (line) => {
      if (findFilesSessions.get(owner.key) !== session) {
        return;
      }

      if (session.totalResultCount >= MAX_FIND_FILES_RESULTS) {
        cancelSession(findFilesSessions, owner.key);
        return;
      }

      const batch = session.resultBatches.get(target.projectId);
      if (!batch) {
        return;
      }

      batch.push(line);
      session.totalResultCount += 1;

      if (batch.length === 1 && !session.batchTimeout) {
        emitFindFileResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      if (batch.length >= 25) {
        emitFindFileResults(session.owner, query, target.projectId, [...batch]);
        batch.length = 0;
        return;
      }

      scheduleFindFileFlush(session, query);
    });
  }
}

async function findFirstNestedGitRepo(searchPath: string, timeoutMs = 5_000) {
  if (FD_BINARY_PATH) {
    const process = Bun.spawn(
      [
        FD_BINARY_PATH,
        "--type",
        "d",
        "--hidden",
        "--max-results",
        "1",
        "^.git$",
        searchPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const resultPromise = new Response(process.stdout).text();
    const timeoutPromise = new Promise<string>((resolve) => {
      setTimeout(() => {
        try {
          process.kill();
        } catch {
          // Ignore timeout cleanup failures.
        }
        resolve("TIMEOUT");
      }, timeoutMs);
    });

    const output = await Promise.race([resultPromise, timeoutPromise]);
    if (!process.killed) {
      await process.exited;
    }
    if (output === "TIMEOUT") {
      return null;
    }
    const result = String(output || "").trim().split("\n")[0];
    return result || null;
  }

  const process = Bun.spawn(
    [
      "find",
      searchPath,
      "-type",
      "d",
      "-name",
      ".git",
      "-print",
      "-quit",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(process.stdout).text();
  return output.trim().split("\n")[0] || null;
}

function makeFileNameSafe(input: string) {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "untitled")
    .replace(/^$/, "untitled");
}

function getUniqueNewName(parentPath: string, baseName: string) {
  const safeBase = makeFileNameSafe(baseName);
  let candidate = safeBase;
  let index = 2;
  while (existsSync(join(parentPath, candidate))) {
    candidate = `${safeBase} ${index}`;
    index += 1;
  }
  return candidate;
}

function getNodeForPath(path: string) {
  if (!existsSync(path)) {
    return null;
  }

  const name = basename(path);
  const stat = statSync(path);

  if (stat.isDirectory()) {
    const children = readdirSync(path)
      .filter((entry) => !isIgnoredPath(join(path, entry)))
      .sort((left, right) => left.localeCompare(right));
    return {
      name,
      type: "dir" as const,
      path,
      children,
    };
  }

  return {
    name,
    type: "file" as const,
    path,
    persistedContent: "",
    isDirty: false,
    model: null,
    editors: {},
    isCached: false,
  };
}

function readSlateConfig(path: string) {
  const configPath = statSync(path).isDirectory() ? join(path, ACTIVE_SLATE_CONFIG_FILE) : path;
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function readFile(path: string): FileReadResponse {
  const textContent = readFileSync(path, "utf8");
  return {
    textContent,
    isBinary: false,
    loadedBytes: textContent.length,
    totalBytes: textContent.length,
  };
}

function pathStartsWithPath(path: string, rootPath: string) {
  return path === rootPath || path.startsWith(`${rootPath}${sep}`);
}

function isIgnoredPath(path: string) {
  const parts = path.split(/[\\/]+/);
  return parts.includes("node_modules") || parts.includes(".git") || path.endsWith("/.DS_Store");
}

function isIgnoredWatchDirectory(path: string) {
  return WATCH_IGNORED_DIR_NAMES.has(basename(path)) || isIgnoredPath(path);
}

function emitFileWatchPayload(absolutePath: string, workspaceId?: string | null) {
  if (!watchOwnerCarrotId) {
    return;
  }

  const exists = existsSync(absolutePath);
  let isFile = false;
  let isDir = false;

  if (exists) {
    try {
      const stat = statSync(absolutePath);
      isFile = stat.isFile();
      isDir = stat.isDirectory();
    } catch {
      // Ignore transient stat failures.
    }
  }

  Carrots.emit(watchOwnerCarrotId, "fs-file-watch-event", {
    absolutePath,
    workspaceId: workspaceId || undefined,
    exists,
    isDelete: !exists,
    isAdding: exists,
    isFile,
    isDir,
  });
}

function emitFileWatchForPath(absolutePath: string) {
  const workspaceIds = new Set<string>();
  for (const target of watchedProjects.values()) {
    if (pathStartsWithPath(absolutePath, target.path)) {
      if (target.workspaceId) {
        workspaceIds.add(target.workspaceId);
      }
    }
  }

  if (workspaceIds.size === 0) {
    emitFileWatchPayload(absolutePath);
    return;
  }

  for (const workspaceId of workspaceIds) {
    emitFileWatchPayload(absolutePath, workspaceId);
  }
}

function attachWatcherErrorHandler(watcher: ProjectDirectoryWatcher, _label: string) {
  (watcher as FSWatcher).on?.("error", () => {
    // Ignore watcher errors; a later sync will recreate healthy watchers.
  });
}

function createProjectDirectoryWatcher(
  rootPath: string,
  onChange: (absolutePath: string) => void,
): ProjectDirectoryWatcher {
  if (process.platform !== "linux") {
    const watcher = watch(
      rootPath,
      { recursive: true },
      (_eventType, relativePath) => {
        if (!relativePath) {
          return;
        }
        onChange(join(rootPath, relativePath));
      },
    );
    attachWatcherErrorHandler(watcher, rootPath);
    return watcher;
  }

  const watchers: FSWatcher[] = [];
  const watchedDirs = new Set<string>();
  let closed = false;

  const addDirectory = (dir: string, isRoot = false) => {
    if (closed || watchedDirs.has(dir)) {
      return;
    }
    if (!isRoot && isIgnoredWatchDirectory(dir)) {
      return;
    }

    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return;
      }
    } catch {
      return;
    }

    try {
      const watcher = watch(dir, { recursive: false }, (_eventType, relativePath) => {
        if (closed || !relativePath) {
          return;
        }

        const absolutePath = join(dir, relativePath);
        if (isIgnoredPath(absolutePath)) {
          return;
        }

        if (existsSync(absolutePath)) {
          try {
            const stat = lstatSync(absolutePath);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
              addDirectory(absolutePath);
            }
          } catch {
            // Ignore transient lstat failures.
          }
        }

        onChange(absolutePath);
      });
      attachWatcherErrorHandler(watcher, dir);
      watchers.push(watcher);
      watchedDirs.add(dir);
    } catch {
      if (isRoot) {
        throw new Error(`Failed to watch ${dir}`);
      }
      return;
    }

    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      addDirectory(join(dir, entry.name));
    }
  };

  addDirectory(rootPath, true);

  return {
    close: () => {
      closed = true;
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Ignore shutdown failures.
        }
      }
    },
  };
}

function syncDirectoryWatchers() {
  const nextRoots = new Set(
    Array.from(watchedProjects.values())
      .map((project) => project.path)
      .filter((projectPath) => existsSync(projectPath)),
  );

  for (const [rootPath, watcher] of directoryWatchers.entries()) {
    if (nextRoots.has(rootPath)) {
      continue;
    }
    watcher.close();
    directoryWatchers.delete(rootPath);
  }

  for (const rootPath of nextRoots) {
    if (directoryWatchers.has(rootPath)) {
      continue;
    }

    const watcher = createProjectDirectoryWatcher(rootPath, (absolutePath) => {
      if (isIgnoredPath(absolutePath)) {
        return;
      }
      emitFileWatchForPath(absolutePath);
    });
    directoryWatchers.set(rootPath, watcher);
  }
}

function syncProjectWatchTargets(owner: SearchOwner, targets: FileWatchTarget[]) {
  watchOwnerCarrotId = owner.carrotId;
  watchedProjects.clear();

  for (const target of targets) {
    if (!target.watchId || !target.path) {
      continue;
    }
    watchedProjects.set(target.watchId, {
      watchId: target.watchId,
      workspaceId: target.workspaceId ?? null,
      path: target.path,
    });
  }

  syncDirectoryWatchers();
}

async function handleRequest(method: string, params: unknown) {
  switch (method) {
    case "syncProjectWatchers": {
      const request = (params ?? {}) as {
        __source?: InvocationSource;
        projects?: Array<{ watchId?: string; workspaceId?: string; path?: string }>;
      };
      const owner = extractSource(request);
      const targets = Array.isArray(request.projects)
        ? request.projects
            .filter(
              (target): target is { watchId: string; workspaceId?: string; path: string } =>
                Boolean(target && typeof target.watchId === "string" && typeof target.path === "string"),
            )
            .map((target) => ({
              watchId: target.watchId,
              workspaceId: typeof target.workspaceId === "string" ? target.workspaceId : undefined,
              path: target.path,
            }))
        : [];
      syncProjectWatchTargets(owner, targets);
      return true;
    }
    case "getNode":
      return getNodeForPath(String((params as { path?: string } | undefined)?.path || ""));
    case "readSlateConfigFile":
      return readSlateConfig(String((params as { path?: string } | undefined)?.path || ""));
    case "readFile":
      return readFile(String((params as { path?: string } | undefined)?.path || ""));
    case "writeFile":
      try {
        const path = String((params as { path?: string } | undefined)?.path || "");
        writeFileSync(path, String((params as { value?: string } | undefined)?.value || ""));
        emitFileWatchForPath(path);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "touchFile":
      try {
        const path = String((params as { path?: string; contents?: string } | undefined)?.path || "");
        writeFileSync(path, String((params as { contents?: string } | undefined)?.contents || ""), {
          flag: existsSync(path) ? "a" : "w",
        });
        emitFileWatchForPath(path);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "rename":
      try {
        const oldPath = String((params as { oldPath?: string } | undefined)?.oldPath || "");
        const newPath = String((params as { newPath?: string } | undefined)?.newPath || "");
        renameSync(oldPath, newPath);
        emitFileWatchForPath(oldPath);
        emitFileWatchForPath(newPath);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "exists":
      return existsSync(String((params as { path?: string } | undefined)?.path || ""));
    case "isFolder": {
      const path = String((params as { path?: string } | undefined)?.path || "");
      try {
        return existsSync(path) && statSync(path).isDirectory();
      } catch {
        return false;
      }
    }
    case "mkdir":
      try {
        const path = String((params as { path?: string } | undefined)?.path || "");
        mkdirSync(path, { recursive: true });
        emitFileWatchForPath(path);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    case "copy": {
      const request = (params ?? {}) as { src?: string; dest?: string };
      cpSync(String(request.src || ""), String(request.dest || ""), { recursive: true });
      emitFileWatchForPath(String(request.dest || ""));
      return;
    }
    case "safeDeleteFileOrFolder":
    case "safeTrashFileOrFolder": {
      const request = (params ?? {}) as { path?: string };
      const path = String(request.path || "");
      rmSync(path, { recursive: true, force: true });
      emitFileWatchForPath(path);
      return;
    }
    case "makeFileNameSafe":
      return makeFileNameSafe(String((params as { value?: string } | undefined)?.value || ""));
    case "getUniqueNewName": {
      const request = (params ?? {}) as { parentPath?: string; baseName?: string };
      return getUniqueNewName(String(request.parentPath || ""), String(request.baseName || "untitled"));
    }
    case "findAllInWorkspace": {
      const request = (params ?? {}) as SearchRequestParams;
      const owner = extractSource(request);
      const query = String(request.query || "").trim();
      const targets = Array.isArray(request.targets)
        ? request.targets
            .filter(
              (target): target is SearchTarget =>
                Boolean(target && typeof target.projectId === "string" && typeof target.path === "string"),
            )
            .map((target) => ({
              projectId: target.projectId,
              path: target.path,
            }))
        : [];

      cancelSession(findAllSessions, owner.key);
      if (!query || targets.length === 0) {
        return [];
      }

      startFindAllSearch(owner, query, targets);
      return [];
    }
    case "findFilesInWorkspace": {
      const request = (params ?? {}) as SearchRequestParams;
      const owner = extractSource(request);
      const query = String(request.query || "").trim();
      const targets = Array.isArray(request.targets)
        ? request.targets
            .filter(
              (target): target is SearchTarget =>
                Boolean(target && typeof target.projectId === "string" && typeof target.path === "string"),
            )
            .map((target) => ({
              projectId: target.projectId,
              path: target.path,
            }))
        : [];

      cancelSession(findFilesSessions, owner.key);
      if (!query || targets.length === 0) {
        return [];
      }

      startFindFileSearch(owner, query, targets);
      return [];
    }
    case "cancelFindAll": {
      const owner = extractSource((params ?? {}) as CancelSearchParams);
      return cancelSession(findAllSessions, owner.key);
    }
    case "cancelFileSearch": {
      const owner = extractSource((params ?? {}) as CancelSearchParams);
      return cancelSession(findFilesSessions, owner.key);
    }
    case "findFirstNestedGitRepo": {
      const request = (params ?? {}) as FindFirstNestedGitRepoParams;
      return findFirstNestedGitRepo(
        String(request.searchPath || ""),
        Number(request.timeoutMs || 5_000),
      );
    }
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
  cancelAllSessions();
  closeAllDirectoryWatchers();
});

self.postMessage({ type: "ready" });
