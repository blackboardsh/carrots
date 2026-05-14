import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { DiffEditor } from "../lens/DiffEditor";

type StageLinesHandler = (
  filePath: string,
  startLine: number,
  endLine: number,
  lineChange?: any,
  originalText?: string,
  modifiedText?: string,
) => void;

type UnstageLinesHandler = (
  filePath: string,
  startLine: number,
  endLine: number,
  lineChange?: any,
  originalText?: string,
  stagedText?: string,
) => void;

export class DashDiffEditorElement extends HTMLElement {
  private dispose: (() => void) | null = null;

  private _originalText = "";
  private _modifiedText = "";
  private _filePath = "";
  private _canStageLines = false;
  private _isStaged = false;
  private _onStageLines?: StageLinesHandler;
  private _onUnstageLines?: UnstageLinesHandler;

  private setOriginalText?: (value: string) => void;
  private setModifiedText?: (value: string) => void;
  private setFilePath?: (value: string) => void;
  private setCanStageLines?: (value: boolean) => void;
  private setIsStaged?: (value: boolean) => void;
  private setOnStageLines?: (value: StageLinesHandler | undefined) => void;
  private setOnUnstageLines?: (value: UnstageLinesHandler | undefined) => void;

  get originalText() {
    return this._originalText;
  }
  set originalText(value: string) {
    this._originalText = value || "";
    console.log("[dash-diff-editor] originalText", this._originalText.length);
    this.setOriginalText?.(this._originalText);
  }

  get modifiedText() {
    return this._modifiedText;
  }
  set modifiedText(value: string) {
    this._modifiedText = value || "";
    console.log("[dash-diff-editor] modifiedText", this._modifiedText.length);
    this.setModifiedText?.(this._modifiedText);
  }

  get filePath() {
    return this._filePath;
  }
  set filePath(value: string) {
    this._filePath = value || "";
    this.setFilePath?.(this._filePath);
  }

  get canStageLines() {
    return this._canStageLines;
  }
  set canStageLines(value: boolean) {
    this._canStageLines = !!value;
    this.setCanStageLines?.(this._canStageLines);
  }

  get isStaged() {
    return this._isStaged;
  }
  set isStaged(value: boolean) {
    this._isStaged = !!value;
    this.setIsStaged?.(this._isStaged);
  }

  get onStageLines() {
    return this._onStageLines;
  }
  set onStageLines(value: StageLinesHandler | undefined) {
    this._onStageLines = value;
    this.setOnStageLines?.(value);
  }

  get onUnstageLines() {
    return this._onUnstageLines;
  }
  set onUnstageLines(value: UnstageLinesHandler | undefined) {
    this._onUnstageLines = value;
    this.setOnUnstageLines?.(value);
  }

  connectedCallback() {
    if (this.dispose) {
      return;
    }

    console.log("[dash-diff-editor] connected", {
      originalLength: this._originalText.length,
      modifiedLength: this._modifiedText.length,
      filePath: this._filePath,
    });

    this.style.display = "block";
    this.style.width = "100%";
    this.style.height = "100%";
    this.style.minHeight = "0";

    const [originalText, setOriginalText] = createSignal(this._originalText);
    const [modifiedText, setModifiedText] = createSignal(this._modifiedText);
    const [filePath, setFilePath] = createSignal(this._filePath);
    const [canStageLines, setCanStageLines] = createSignal(this._canStageLines);
    const [isStaged, setIsStaged] = createSignal(this._isStaged);
    const [onStageLines, setOnStageLines] = createSignal<StageLinesHandler | undefined>(
      this._onStageLines,
    );
    const [onUnstageLines, setOnUnstageLines] =
      createSignal<UnstageLinesHandler | undefined>(this._onUnstageLines);

    this.setOriginalText = setOriginalText;
    this.setModifiedText = setModifiedText;
    this.setFilePath = setFilePath;
    this.setCanStageLines = setCanStageLines;
    this.setIsStaged = setIsStaged;
    this.setOnStageLines = setOnStageLines;
    this.setOnUnstageLines = setOnUnstageLines;

    this.dispose = render(
      () => (
        <DiffEditor
          originalText={originalText}
          modifiedText={modifiedText}
          onStageLines={onStageLines()}
          onUnstageLines={onUnstageLines()}
          canStageLines={canStageLines()}
          filePath={filePath()}
          isStaged={isStaged()}
        />
      ),
      this,
    );
  }

  disconnectedCallback() {
    this.dispose?.();
    this.dispose = null;
    this.setOriginalText = undefined;
    this.setModifiedText = undefined;
    this.setFilePath = undefined;
    this.setCanStageLines = undefined;
    this.setIsStaged = undefined;
    this.setOnStageLines = undefined;
    this.setOnUnstageLines = undefined;
  }
}

export function registerDashDiffEditor() {
  if (!customElements.get("dash-diff-editor")) {
    customElements.define("dash-diff-editor", DashDiffEditorElement);
  }
}
