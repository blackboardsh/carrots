import { type RPCSchema } from "electrobun/view";
import type {
  PreviewFileTreeType,
  ParsedResponseType,
  PanePathType,
  SlateType,
} from "../../shared/types/types";
import type { AppState } from "./store";
import type { WorkspaceType } from "./store";
import type { track } from "../../main/utils/analytics";

export type WorkspaceRPC = {
  // to bun
  bun: RPCSchema<{
    requests: {
      logoutBunnyCloud: {
        params: void;
        response: {
          ok: boolean;
        };
      };
      getBunnyCloudOverview: {
        params: void;
        response: any;
      };
      loginBunnyCloud: {
        params: {
          mode: "login" | "register";
          email: string;
          password: string;
          name?: string;
        };
        response: {
          ok: boolean;
          error?: string;
          overview?: any;
        };
      };
      registerCurrentBunnyCloudInstance: {
        params: void;
        response: {
          ok: boolean;
          error?: string;
          overview?: any;
        };
      };
      updateCurrentBunnyCloudCarrots: {
        params: void;
        response: {
          ok: boolean;
          overview?: any;
        };
      };
      createBunnyCloudWorkspace: {
        params: {
          name: string;
          description?: string;
        };
        response: {
          ok: boolean;
          overview?: any;
        };
      };
      removeBunnyCloudInstance: {
        params: {
          instanceId: string;
        };
        response: {
          ok: boolean;
          overview?: any;
        };
      };
      revokeBunnyCloudDevice: {
        params: {
          deviceTokenId: string;
        };
        response: {
          ok: boolean;
          overview?: any;
        };
      };
      getInitialState: {
        params: void;
        response: any;
      };
      getDashHostBootState: {
        params: void;
        response: any;
      };
      openLens: {
        params: {
          lensId: string;
        };
        response: any;
      };
      openLensInNewWindow: {
        params: {
          lensId: string;
        };
        response: any;
      };
      openWorkspace: {
        params: {
          workspaceId: string;
        };
        response: any;
      };
      openWorkspaceInNewWindow: {
        params: {
          workspaceId: string;
        };
        response: any;
      };
      overwriteCurrentLens: {
        params: void;
        response: any;
      };
      createLens: {
        params: {
          workspaceId: string;
          name?: string;
          description?: string;
          sourceLensId?: string;
        };
        response: any;
      };
      renameLens: {
        params: {
          lensId: string;
          name: string;
          description?: string;
        };
        response: any;
      };
      showContextMenu: {
        params: {
          // todo: electrobun should expose menu items type
          menuItems: any[];
        };
      };
      newPreviewNode: {
        params: {
          candidateName: string;
        };
        response: PreviewFileTreeType;
      };
      getFaviconForUrl: {
        params: {
          url: string;
        };
        response: string;
      };
      copy: {
        params: {
          src: string;
          dest: string;
        };
        response: void;
      };
      findFirstNestedGitRepo: {
        params: {
          searchPath: string;
          timeoutMs?: number;
        };
        response: string | null;
      };
      syncWorkspace: {
        params: {
          workspace: WorkspaceType;
        };
        response: void;
      };
      syncAppSettings: {
        params: {
          appSettings: AppState["appSettings"];
        };
        response: void;
      };
      getLocalDashGraph: {
        params: void;
        response: any;
      };
      syncLocalDashGraph: {
        params: {
          graph: any;
        };
        response: void;
      };
      syncLocalCurrentWindow: {
        params: {
          workspaceId: string;
          lensId: string;
          windowId: string;
          activeTreeNodeId: string;
          window: {
            id: string;
            title: string;
            workspaceId: string;
            mainTabIds: string[];
            sideTabIds: string[];
            currentMainTabId: string;
            currentSideTabId: string;
          };
        };
        response: void;
      };
      openFileDialog: {
        params: {
          startingFolder: string;
          allowedFileTypes: string;
          canChooseFiles: boolean;
          canChooseDirectory: boolean;
          allowsMultipleSelection: boolean;
        };
        response: string[];
      };
      findAllInWorkspace: {
        params: {
          query: string;
        };
        response: {
          path: string;
          line: number;
          column: number;
          match: string;
        }[];
      };
      findFilesInWorkspace: {
        params: {
          query: string;
        };
        response: string[];
      };
      cancelFileSearch: {
        params: void;
        response: boolean;
      };
      cancelFindAll: {
        params: void;
        response: boolean;
      };
      getNode: {
        params: {
          path: string;
        };
        response:
          | {
              name: string;
              type: "dir";
              path: string;
              children: string[];
            }
          | {
              name: string;
              type: "file";
              path: string;
              persistedContent: "";
              isDirty: false;
              model: null;
              editors: {};
            }
          | null;
      };
      readSlateConfigFile: {
        params: {
          path: string;
        };
        response: SlateType | null;
      };
      readFile: {
        params: {
          path: string;
        };
        response: {
          textContent: string;
        };
      };
      writeFile: {
        params: {
          path: string;
          value: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      touchFile: {
        params: {
          path: string;
          contents?: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      rename: {
        params: {
          oldPath: string;
          newPath: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      exists: {
        params: {
          path: string;
        };
        response: boolean;
      };
      showInFinder: {
        params: {
          path: string;
        };
        response: void;
      };
      mkdir: {
        params: {
          path: string;
        };
        response: {
          success: boolean;
          error?: string;
        };
      };
      isFolder: {
        params: {
          path: string;
        };
        response: boolean;
      };
      getUniqueNewName: {
        params: {
          parentPath: string;
          baseName: string;
        };
        response: string;
      };
      makeFileNameSafe: {
        params: {
          candidateFilename: string;
        };
        response: string;
      };
      createTerminal: {
        params: {
          cwd: string;
          shell?: string;
        };
        response: string;
      };
      writeToTerminal: {
        params: {
          terminalId: string;
          data: string;
        };
        response: boolean;
      };
      resizeTerminal: {
        params: {
          terminalId: string;
          cols: number;
          rows: number;
        };
        response: boolean;
      };
      killTerminal: {
        params: {
          terminalId: string;
        };
        response: boolean;
      };
      getTerminalCwd: {
        params: {
          terminalId: string;
        };
        response: string | null;
      };
    };
    messages: {
      removeProjectDirectoryWatcher: {
        projectId: string;
      };
      closeProjectDirectoryWatcher: {
        projectId: string;
      };
      createHostWindow: {
        windowId: string;
        title?: string;
        frame?: {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        };
      };
      closeWindow: {
        windowId?: string;
      } | void;
      syncDashHostCache: any;
      openBunnyWindow: {
        screenX: number;
        screenY: number;
      };
      installUpdateNow: void;
      addToken: {
        name: string;
        url: string;
        endpoint: string;
        token: string;
      };
      deleteToken: {
        tokenId: string;
      };
      fullyDeleteNodeFromDisk: {
        nodePath: string;
      };
      syncDevlink: {
        nodePath: string;
      };
      track: {
        event: keyof typeof track;
        properties?: any;
      };
    };
  }>;
  // to webview
  webview: RPCSchema<{
    requests: {};
    messages: {
      initState: {
        windowId: string;
        buildVars: any;
        paths: any;
        peerDependencies: any;
      };
      updateStatus: Partial<AppState["update"]>;
      setProjects: {
        projects: any;
        tokens: any;
        workspace: any;
        appSettings: any;
        bunnyDash: {
          currentWorkspaceId: string;
          currentLensId: string;
          instances: Array<{
            id: string;
            name: string;
            os: string;
            status: string;
            isCurrent: boolean;
            carrots: Array<{
              id: string;
              name: string;
              description: string;
              version: string;
              mode: string;
              permissions: string[];
              status: string;
            }>;
          }>;
          workspaces: Array<{
            id: string;
            name: string;
            subtitle: string;
            isCurrent: boolean;
            currentLensId: string;
            currentLensIsActive: boolean;
            canExpand: boolean;
            lenses: Array<{
              id: string;
              name: string;
              description: string;
              workspaceId: string;
              isCurrent: boolean;
              isDirty: boolean;
            }>;
          }>;
          cloudWorkspaces: Array<{
            id: string;
            name: string;
            subtitle: string;
            runtimeWorkspaceId: string;
            isCurrent: boolean;
            canExpand: boolean;
            lenses: Array<{
              id: string;
              name: string;
              description: string;
              workspaceId: string;
              runtimeLensId: string;
              isCurrent: boolean;
            }>;
            linkedInstances: Array<{
              id: string;
              name: string;
              os: string;
              status: string;
              isCurrent: boolean;
              mounts: Array<{
                id: string;
                workspaceId: string;
                workspaceName: string;
                instanceId: string;
                path: string;
                name: string;
              }>;
            }>;
          }>;
          knownLocalProjects: Array<{
            id: string;
            name: string;
            path: string;
            instanceId: string;
            instanceLabel: string;
            kind: string;
            status: string;
          }>;
        };
      };
      fileWatchEvent: {
        absolutePath: string;
        exists: boolean;
        isDelete: boolean;
        isAdding: boolean;
        isFile: boolean;
        isDir: boolean;
      };
      tsServerMessage: {
        message: ParsedResponseType;
        metadata: {
          workspaceId: string;
          windowId: string;
          editorId: string;
        };
      };
      focusTab: {
        tabId: string;
      };
      openNewTab: {
        nodePath: string;
      };
      openUrlInNewTab: {
        url: string;
      };
      showLensSettings: {
        mode: "create" | "rename";
        workspaceId: string;
        lensId?: string;
        sourceLensId?: string;
        name: string;
        description?: string;
      };
      showNodeSettings: {
        nodePath: string;
      };
      addChildNode: {
        nodePath: string;
        nodeType?: string;
      };
      createSpecialFile: {
        nodePath: string;
        fileType: string;
      };
      deleteProject: {
        projectId: string;
      };

      splitPaneContainer: {
        pathToPane: PanePathType;
        direction: "row" | "column";
      };
      findAllInFolderResult: {
        query: string;
        projectId: string;
        results: {
          path: string;
          line: number;
          column: number;
          match: string;
        }[];
      };
      findFilesInWorkspaceResult: {
        query: string;
        projectId: string;
        results: string[];
      };
      openCommandPalette: void;
      newBrowserTab: void;
      closeCurrentTab: void;
      closeCurrentWindow: void;
      openSettings: {
        settingsType: string;
      };
      openGitCloneUI: {
        nodePath: string;
      };
      initGitInFolder: {
        nodePath: string;
      };
      handleGlobalShortcut: {
        key: string;
        ctrl: boolean;
        shift: boolean;
        alt: boolean;
        meta: boolean;
      };
      terminalOutput: {
        terminalId: string;
        data: string;
      };
      terminalExit: {
        terminalId: string;
        exitCode: number;
        signal?: number;
      };
      beginWindowTransition: {
        label: string;
      };
      endWindowTransition: {};
      // Open a file in the editor (from edit command, Open menu, or drag-drop)
      openFileInEditor: {
        filePath: string;
        createIfNotExists?: boolean;
      };
      // Open a folder as a project
      openFolderAsProject: {
        folderPath: string;
      };
      // Open a terminal at a specific directory
      newTerminal: {
        nodePath: string;
      };
      // Remove a file from the open files list
      removeOpenFile: {
        filePath: string;
      };
      refreshBunnyDashState: void;
    };
  }>;
};
