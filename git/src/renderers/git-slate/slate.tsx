import { render } from "solid-js/web";
import { GitSlate } from "./GitSlate";

type SlateMountContext = {
  nodePath?: string;
  invokeCarrot: <T = unknown>(carrotId: string, method: string, params?: unknown) => Promise<T>;
  sendToHost: (message: Record<string, unknown>) => void;
};

export function mount(container: HTMLElement, context: SlateMountContext) {
  const dispose = render(
    () => (
      <GitSlate
        nodePath={context.nodePath || ""}
        bridge={{
          invokeCarrot: context.invokeCarrot,
          sendToHost: context.sendToHost,
        }}
      />
    ),
    container,
  );

  return () => {
    dispose();
  };
}
