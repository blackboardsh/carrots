import { createMemo, onCleanup, onMount, Show, type JSX } from "solid-js";
import { getNode } from "../FileWatcher";
import { openNewTabForNode, setNodeExpanded, setState, state } from "../store";
import { getDashHostBootState } from "../init";

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

function parseHostMessage(raw: unknown): HostMessage | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as HostMessage;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") {
    return raw as HostMessage;
  }
  return null;
}

type CarrotUIInvokeRequest = {
  __dashCarrotUI: true;
  type: "invoke-carrot";
  requestId: string;
  carrotId: string;
  method: string;
  params?: unknown;
};

type CarrotUIHostMessageEnvelope = {
  __dashCarrotUI: true;
  type: "host-message";
  payload: unknown;
};

type CarrotUIChildMessage = CarrotUIInvokeRequest | CarrotUIHostMessageEnvelope;

function openUrlInDash(url: string) {
  openNewTabForNode("__BUNNY_INTERNAL__/web", false, {
    focusNewTab: true,
    url,
  });
}

export function handleCloneSuccessInDash(folderPath: string) {
  setNodeExpanded(folderPath, true);

  let folderAttempts = 0;
  const maxFolderAttempts = 20;
  const gitFolderPath = `${folderPath.replace(/\/+$/, "")}/.git`;

  const openGitTabWhenReady = () => {
    const gitNode = getNode(gitFolderPath);
    if (gitNode) {
      openNewTabForNode(gitFolderPath, false, { focusNewTab: true });
      return;
    }

    folderAttempts += 1;
    if (folderAttempts >= maxFolderAttempts) {
      return;
    }
    setTimeout(openGitTabWhenReady, 500);
  };

  const expandFolderWhenReady = () => {
    const folderNode = getNode(folderPath);
    if (folderNode) {
      setNodeExpanded(folderPath, true);
      openGitTabWhenReady();
      return;
    }

    folderAttempts += 1;
    if (folderAttempts >= maxFolderAttempts) {
      return;
    }
    setTimeout(expandFolderWhenReady, 500);
  };

  expandFolderWhenReady();
}

export const CarrotRemoteUIHost = (props: {
  carrotId: string;
  remoteUIId: string;
  query?: Record<string, string | undefined>;
  style?: JSX.CSSProperties;
  class?: string;
  onHostMessage?: (message: HostMessage) => void;
}) => {
  let iframeRef: HTMLIFrameElement | undefined;

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
    if (!props.carrotId || !props.remoteUIId) {
      return "";
    }

    const origin = state.webBridgeOrigin || "";
    if (!origin) {
      return "";
    }

    const url = new URL(
      `${origin}/carrot/${encodeURIComponent(props.carrotId)}/remote-ui/${encodeURIComponent(props.remoteUIId)}/index.html`,
    );

    for (const [key, value] of Object.entries(props.query || {})) {
      if (typeof value === "string" && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }

    return url.toString();
  });

  const handleMessage = (event: CustomEvent) => {
    const message = parseHostMessage((event as any).detail);
    if (!message) {
      return;
    }

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
      default:
        break;
    }

    props.onHostMessage?.(message);
  };

  onCleanup(() => {
    iframeRef = undefined;
  });

  onMount(() => {
    const handleIframeMessage = async (event: MessageEvent) => {
      if (!iframeRef?.contentWindow || event.source !== iframeRef.contentWindow) {
        return;
      }

      const data = event.data as CarrotUIChildMessage | undefined;
      if (!data || data.__dashCarrotUI !== true) {
        return;
      }

      if (data.type === "host-message") {
        const parsed = parseHostMessage(data.payload);
        if (parsed) {
          handleMessage({ detail: parsed } as CustomEvent);
        }
        return;
      }

      if (data.type === "invoke-carrot") {
        try {
          const result = await electrobun.carrots.invoke(
            String(data.carrotId || ""),
            String(data.method || ""),
            data.params,
          );
          iframeRef.contentWindow.postMessage(
            {
              __dashCarrotUIHost: true,
              type: "invoke-carrot-response",
              requestId: data.requestId,
              success: true,
              result,
            },
            "*",
          );
        } catch (error) {
          iframeRef.contentWindow.postMessage(
            {
              __dashCarrotUIHost: true,
              type: "invoke-carrot-response",
              requestId: data.requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            "*",
          );
        }
      }
    };

    window.addEventListener("message", handleIframeMessage);
    onCleanup(() => {
      window.removeEventListener("message", handleIframeMessage);
    });
  });

  return (
    <Show
      when={src()}
      fallback={
        <div
          style={{
            height: "100%",
            width: "100%",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            background: "#1e1e1e",
            color: "#9ca3af",
            "font-size": "13px",
          }}
        >
          This carrot UI is unavailable because the local Bunny Ears bridge is not ready.
        </div>
      }
    >
      <iframe
        ref={(el) => {
          iframeRef = el;
        }}
        class={props.class}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          background: "#1e1e1e",
          ...(props.style || {}),
        }}
        src={src()}
      />
    </Show>
  );
};
