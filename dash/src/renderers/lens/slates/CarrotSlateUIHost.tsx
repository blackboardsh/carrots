import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { openNewTabForNode, setState, state } from "../store";
import { getDashHostBootState } from "../init";
import { handleCloneSuccessInDash } from "./CarrotRemoteUIHost";

type HostMessage =
  | {
      type: "open-file";
      path: string;
      focusNewTab?: boolean;
    }
  | {
      type: "open-url";
      url: string;
    }
  | {
      type: "close-settings";
    }
  | {
      type: "clone-success";
      folderPath: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type CarrotSlateUIMountContext = {
  carrotId: string;
  slateUIId: string;
  nodePath?: string;
  query?: Record<string, string | undefined>;
  invokeCarrot: <T = unknown>(carrotId: string, method: string, params?: unknown) => Promise<T>;
  invokeCurrentCarrot: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  sendToHost: (message: HostMessage) => void;
};

type CarrotSlateUIModule = {
  mount?: (
    container: HTMLElement,
    context: CarrotSlateUIMountContext,
  ) => void | (() => void) | { unmount?: () => void };
  default?: unknown;
};

const moduleCache = new Map<string, Promise<CarrotSlateUIModule>>();
const stylesheetRefCounts = new Map<string, number>();

function ensureStylesheet(url: string) {
  if (!url) {
    return () => {};
  }

  const currentCount = stylesheetRefCounts.get(url) || 0;
  stylesheetRefCounts.set(url, currentCount + 1);

  let link = document.querySelector<HTMLLinkElement>(
    `link[data-carrot-slate-ui-style="${CSS.escape(url)}"]`,
  );

  if (!link) {
    link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.dataset.carrotSlateUiStyle = url;
    document.head.appendChild(link);
  }

  return () => {
    const nextCount = (stylesheetRefCounts.get(url) || 1) - 1;
    if (nextCount <= 0) {
      stylesheetRefCounts.delete(url);
      link?.remove();
      return;
    }
    stylesheetRefCounts.set(url, nextCount);
  };
}

function openUrlInDash(url: string) {
  openNewTabForNode("__BUNNY_INTERNAL__/web", false, {
    focusNewTab: true,
    url,
  });
}

function loadCarrotSlateModule(url: string) {
  let promise = moduleCache.get(url);
  if (!promise) {
    promise = import(/* @vite-ignore */ url) as Promise<CarrotSlateUIModule>;
    moduleCache.set(url, promise);
  }
  return promise;
}

function resolveMount(module: CarrotSlateUIModule) {
  if (typeof module.mount === "function") {
    return module.mount;
  }
  if (
    module.default &&
    typeof module.default === "object" &&
    typeof (module.default as any).mount === "function"
  ) {
    return (module.default as any).mount;
  }
  if (typeof module.default === "function") {
    return module.default as CarrotSlateUIModule["mount"];
  }
  return null;
}

export const CarrotSlateUIHost = (props: {
  carrotId: string;
  slateUIId: string;
  nodePath?: string;
  query?: Record<string, string | undefined>;
  style?: JSX.CSSProperties;
  class?: string;
  onHostMessage?: (message: HostMessage) => void;
}) => {
  let containerRef: HTMLDivElement | undefined;
  let cleanupMount: (() => void) | undefined;
  let cleanupStylesheet: (() => void) | undefined;
  let mountVersion = 0;

  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);

  onMount(() => {
    let cancelled = false;

    const ensureBridgeOrigin = async () => {
      if (state.webBridgeOrigin) {
        return;
      }

      for (let attempt = 0; attempt < 20 && !cancelled; attempt += 1) {
        try {
          const response = await getDashHostBootState();
          const nextOrigin =
            response && typeof response.webBridgeOrigin === "string"
              ? response.webBridgeOrigin
              : "";
          if (nextOrigin) {
            setState("webBridgeOrigin", nextOrigin);
            return;
          }
        } catch {}

        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };

    void ensureBridgeOrigin();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const src = createMemo(() => {
    if (!props.carrotId || !props.slateUIId) {
      return "";
    }

    const origin = state.webBridgeOrigin || "";
    if (!origin) {
      return "";
    }

    return `${origin}/carrot/${encodeURIComponent(props.carrotId)}/slate-ui/${encodeURIComponent(props.slateUIId)}/index.js`;
  });

  const mountConfig = createMemo(() => {
    const query = props.query || {};
    const sortedQueryEntries = Object.entries(query).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return {
      moduleUrl: src(),
      nodePath: props.nodePath || "",
      query: Object.fromEntries(sortedQueryEntries),
    };
  });

  const sendToHost = (message: HostMessage) => {
    switch (message.type) {
      case "open-file":
        if (typeof message.path === "string" && message.path) {
          openNewTabForNode(message.path, false, {
            focusNewTab: message.focusNewTab !== false,
          });
        }
        break;
      case "open-url":
        if (typeof message.url === "string" && message.url) {
          openUrlInDash(message.url);
        }
        break;
      case "close-settings":
        setState("settingsPane", { type: "", data: {} });
        break;
      case "clone-success":
        if (typeof message.folderPath === "string" && message.folderPath) {
          handleCloneSuccessInDash(message.folderPath);
        }
        break;
      default:
        break;
    }

    props.onHostMessage?.(message);
  };

  createEffect(() => {
    const { moduleUrl, nodePath, query } = mountConfig();
    const container = containerRef;

    if (!moduleUrl || !container) {
      return;
    }

    const currentMountVersion = ++mountVersion;
    cleanupMount?.();
    cleanupMount = undefined;
    cleanupStylesheet?.();
    cleanupStylesheet = ensureStylesheet(
      new URL("./index.css", moduleUrl).toString(),
    );
    setLoading(true);
    setError("");

    void loadCarrotSlateModule(moduleUrl)
      .then((module) => {
        if (currentMountVersion !== mountVersion || !containerRef) {
          return;
        }

        const mount = resolveMount(module);
        if (!mount) {
          throw new Error(`Slate UI ${props.carrotId}/${props.slateUIId} does not export a mount() function`);
        }

        const result = mount(containerRef, {
          carrotId: props.carrotId,
          slateUIId: props.slateUIId,
          nodePath,
          query,
          invokeCarrot: (carrotId, method, params) =>
            electrobun.carrots.invoke(carrotId, method, params),
          invokeCurrentCarrot: (method, params) =>
            electrobun.carrots.invoke(props.carrotId, method, params),
          sendToHost,
        });

        if (typeof result === "function") {
          cleanupMount = result;
        } else if (result && typeof result === "object" && typeof (result as any).unmount === "function") {
          cleanupMount = () => (result as any).unmount();
        }

        setLoading(false);
      })
      .catch((err) => {
        if (currentMountVersion !== mountVersion) {
          return;
        }
        console.error("[CarrotSlateUIHost] Failed to load slate UI:", err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  });

  onCleanup(() => {
    cleanupMount?.();
    cleanupMount = undefined;
    cleanupStylesheet?.();
    cleanupStylesheet = undefined;
  });

  return (
    <div
      class={props.class}
      style={{
        position: "relative",
        height: "100%",
        width: "100%",
        background: "#1e1e1e",
        ...(props.style || {}),
      }}
    >
      <div
        ref={(el) => {
          containerRef = el;
        }}
        style={{
          height: "100%",
          width: "100%",
          display: error() ? "none" : "block",
        }}
      />
      <Show when={loading() && !error()}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "#1e1e1e",
            color: "#9ca3af",
            "font-size": "13px",
          }}
        >
          Loading carrot UI...
        </div>
      </Show>
      <Show when={!!error()}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "#1e1e1e",
            color: "#fca5a5",
            "font-size": "13px",
            padding: "16px",
            "text-align": "center",
          }}
        >
          Failed to load carrot UI: {error()}
        </div>
      </Show>
    </div>
  );
};
