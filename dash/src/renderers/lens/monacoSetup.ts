import * as monaco from "monaco-editor";

import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/min/vs/editor/editor.main.css";

declare global {
  interface Window {
    __dashMonacoSetupDone?: boolean;
  }
}

if (!window.__dashMonacoSetupDone) {
  window.__dashMonacoSetupDone = true;

  monaco.languages.register({
    id: "typescript",
    extensions: [".ts", ".tsx"],
    aliases: ["TypeScript", "ts", "typescript"],
    mimetypes: ["text/typescript"],
  });

  monaco.languages.register({
    id: "javascript",
    extensions: [".js"],
    aliases: ["JavaScript", "javascript", "js"],
    mimetypes: ["text/javascript"],
  });

  monaco.languages.register({
    id: "css",
    extensions: [".css"],
    aliases: ["CSS", "css"],
    mimetypes: ["text/css"],
  });

  monaco.languages.register({
    id: "html",
    extensions: [".html", ".htm"],
    aliases: ["HTML", "html"],
    mimetypes: ["text/html"],
  });

  monaco.languages.register({
    id: "json",
    extensions: [".json"],
    aliases: ["JSON", "json"],
    mimetypes: ["application/json"],
  });

  monaco.languages.register({
    id: "markdown",
    extensions: [".md", ".markdown"],
    aliases: ["Markdown", "markdown", "md"],
    mimetypes: ["text/markdown"],
  });

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });

  monaco.languages.typescript.typescriptDefaults.setModeConfiguration({
    hovers: false,
    definitions: false,
    completionItems: false,
  });

  self.MonacoEnvironment = {
    baseUrl: "./",
    getWorkerUrl: function (_moduleId, label) {
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
}

export const inferMonacoLanguageFromPath = (filePath?: string) => {
  const normalized = filePath?.toLowerCase() || "";
  if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
    return "typescript";
  }
  if (normalized.endsWith(".js") || normalized.endsWith(".jsx") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return "javascript";
  }
  if (normalized.endsWith(".json")) {
    return "json";
  }
  if (normalized.endsWith(".css")) {
    return "css";
  }
  if (normalized.endsWith(".html") || normalized.endsWith(".htm")) {
    return "html";
  }
  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) {
    return "markdown";
  }
  return "plaintext";
};
