import { render } from "solid-js/web";
import { GitSlate } from "./GitSlate";
import { getQueryParam } from "../shared/bridge";

self.MonacoEnvironment = {
  baseUrl: "./",
  getWorkerUrl: function (_moduleId: string, label: string) {
    if (label === "json") {
      return "./vs/language/json/json.worker.js";
    }
    if (label === "css") {
      return "./vs/language/css/css.worker.js";
    }
    if (label === "html") {
      return "./vs/language/html/html.worker.js";
    }
    if (label === "typescript" || label === "javascript") {
      return "./vs/language/typescript/ts.worker.js";
    }
    return "./vs/editor/editor.worker.js";
  },
};

const root = document.getElementById("app");
if (!root) {
  throw new Error("Git slate root element not found");
}

const nodePath = getQueryParam("nodePath");

render(() => <GitSlate nodePath={nodePath} />, root);
