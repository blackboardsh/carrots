import { render } from "solid-js/web";
import { GitSlate } from "./GitSlate";
import { setEmbeddedBridge } from "../shared/bridge";

type SlateMountContext = {
  nodePath?: string;
  invokeCarrot: <T = unknown>(carrotId: string, method: string, params?: unknown) => Promise<T>;
  sendToHost: (message: Record<string, unknown>) => void;
};

export function mount(container: HTMLElement, context: SlateMountContext) {
  setEmbeddedBridge({
    invokeCarrot: context.invokeCarrot,
    sendToHost: context.sendToHost,
  });

  const dispose = render(
    () => <GitSlate nodePath={context.nodePath || ""} />,
    container,
  );

  return () => {
    dispose();
    setEmbeddedBridge(null);
  };
}
