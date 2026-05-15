type InitMessage = {
  type: "init";
};

type EventMessage = {
  type: "event";
  name?: string;
  payload?: unknown;
};

type RequestMessage = {
  type: "request";
  requestId: number;
  method?: string;
};

function post(message: unknown) {
  self.postMessage(message);
}

function postReady() {
  post({ type: "ready" });
}

function postError(requestId: number, error: string) {
  post({
    type: "response",
    requestId,
    success: false,
    error,
  });
}

self.onmessage = async (event) => {
  const message = event.data as InitMessage | EventMessage | RequestMessage;

  if (message?.type === "init") {
    postReady();
    return;
  }

  if (message?.type === "event") {
    return;
  }

  if (message?.type === "request") {
    postError(message.requestId, `Unknown method: ${String(message.method || "")}`);
  }
};
