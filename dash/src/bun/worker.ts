type RequestMessage = {
  type: "request";
  requestId: number;
  method?: string;
};

function post(message: unknown) {
  self.postMessage(message);
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
  const message = event.data as RequestMessage | { type?: string };

  if (message?.type === "request") {
    postError(message.requestId, `Unknown method: ${String(message.method || "")}`);
  }
};
