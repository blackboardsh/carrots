import { Electroview } from "electrobun/view";

const hasNativeElectrobunBridge =
  typeof window.__electrobun === "object" &&
  window.__electrobun !== null;

type EmbeddedBridge = {
  invokeCarrot: <T = unknown>(carrotId: string, method: string, params?: unknown) => Promise<T>;
  sendToHost: (message: Record<string, unknown>) => void;
};

let embeddedBridge: EmbeddedBridge | null = null;

let nativeElectrobun: Electroview | null = null;

function getNativeElectrobun() {
  if (!hasNativeElectrobunBridge) {
    return null;
  }
  if (!nativeElectrobun) {
    const rpc = Electroview.defineRPC({
      maxRequestTime: 60 * 1000,
      handlers: {
        requests: {},
        messages: {},
      },
    });
    nativeElectrobun = new Electroview({ rpc });
  }
  return nativeElectrobun;
}

export const electrobun = new Proxy({} as Electroview, {
  get(_target, prop, receiver) {
    const instance = getNativeElectrobun();
    if (!instance) {
      return undefined;
    }
    return Reflect.get(instance as any, prop, receiver);
  },
});

export function setEmbeddedBridge(nextBridge: EmbeddedBridge | null) {
  embeddedBridge = nextBridge;
}

type ParentBridgeRequest = {
  __dashCarrotUI: true;
  type: "invoke-carrot";
  requestId: string;
  carrotId: string;
  method: string;
  params?: unknown;
};

type ParentBridgeResponse = {
  __dashCarrotUIHost: true;
  type: "invoke-carrot-response";
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
};

const parentBridgePending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }
>();

if (!hasNativeElectrobunBridge) {
  window.addEventListener("message", (event) => {
    const data = event.data as ParentBridgeResponse | undefined;
    if (!data || data.__dashCarrotUIHost !== true || data.type !== "invoke-carrot-response") {
      return;
    }
    const pending = parentBridgePending.get(data.requestId);
    if (!pending) {
      return;
    }
    parentBridgePending.delete(data.requestId);
    if (data.success) {
      pending.resolve(data.result);
      return;
    }
    pending.reject(new Error(data.error || "Unknown remote UI bridge error"));
  });
}

function invokeViaParentBridge<T = unknown>(
  carrotId: string,
  method: string,
  params?: unknown,
): Promise<T> {
  if (window.parent === window) {
    return Promise.reject(
      new Error("Carrot UI bridge is unavailable outside Dash host"),
    );
  }

  const requestId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise<T>((resolve, reject) => {
    parentBridgePending.set(requestId, { resolve, reject });

    const payload: ParentBridgeRequest = {
      __dashCarrotUI: true,
      type: "invoke-carrot",
      requestId,
      carrotId,
      method,
      params,
    };

    window.parent.postMessage(payload, "*");

    setTimeout(() => {
      const stillPending = parentBridgePending.get(requestId);
      if (!stillPending) {
        return;
      }
      parentBridgePending.delete(requestId);
      reject(new Error(`Timed out invoking ${carrotId}.${method}`));
    }, 60_000);
  });
}

export function invokeGitCarrot<T = unknown>(method: string, params?: unknown) {
  if (embeddedBridge) {
    return embeddedBridge.invokeCarrot<T>("bunny.git", method, params);
  }
  const native = getNativeElectrobun();
  if (native) {
    return native.carrots.invoke<T>("bunny.git", method, params);
  }
  return invokeViaParentBridge<T>("bunny.git", method, params);
}

export function invokeFsCarrot<T = unknown>(method: string, params?: unknown) {
  if (embeddedBridge) {
    return embeddedBridge.invokeCarrot<T>("bunny.fs", method, params);
  }
  const native = getNativeElectrobun();
  if (native) {
    return native.carrots.invoke<T>("bunny.fs", method, params);
  }
  return invokeViaParentBridge<T>("bunny.fs", method, params);
}

export function sendToHost(message: Record<string, unknown>) {
  if (embeddedBridge) {
    embeddedBridge.sendToHost(message);
    return;
  }
  if (typeof window.__electrobunSendToHost === "function") {
    window.__electrobunSendToHost(message);
    return;
  }
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        __dashCarrotUI: true,
        type: "host-message",
        payload: message,
      },
      "*",
    );
  }
}

export function getQueryParam(name: string) {
  return new URLSearchParams(window.location.search).get(name) || "";
}
