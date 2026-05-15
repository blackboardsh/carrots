import { getWindow } from "../store";
import { state, setState } from "../store";
import { createSignal, onMount } from "solid-js";
import { aiCompletionService } from "../services/aiCompletionService";
import { electrobun, invokeLlamaCarrot } from "../init";

type GitIntegrationState = {
  github?: {
    connected?: boolean;
    user?: {
      login?: string;
    } | null;
    username?: string;
  };
};

export const StatusBar = () => {
  const [gitIntegration, setGitIntegration] = createSignal<GitIntegrationState | null>(null);

  const openGitSettings = () => {
    setState("settingsPane", {
      type: "carrot-remote-ui",
      data: {
        title: "Git & GitHub",
        carrotId: "bunny.git",
        remoteUIId: "git-settings",
      },
    });
  };

  const fetchGitIntegration = async () => {
    try {
      const nextState = await electrobun.carrots.invoke<GitIntegrationState>(
        "bunny.git",
        "getGitIntegrationState",
      );
      setGitIntegration(nextState);
    } catch (err) {
      console.warn("Failed to fetch git integration state:", err);
      setGitIntegration(null);
    }
  };

  onMount(() => {
    void fetchGitIntegration();
    const gitInterval = setInterval(() => {
      void fetchGitIntegration();
    }, 5000);
    return () => {
      clearInterval(gitInterval);
    };
  });

  return (
    <div
      style={{
        display: "flex",
        height: "22px",
        width: "100%",
        background: "#181818",
        "border-top": "1px solid #111",
        color: "#fff",
        "font-size": "11px",
        "align-items": "center",
        padding: "10px",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "flex", height: "18px", "align-items": "center" }}>
        <Workspace />
      </div>
      <div style={{ "flex-grow": 1 }} />
      <div style={{ display: "flex", height: "18px", "align-items": "center" }}>
        <Git onOpenSettings={openGitSettings} />
        <span>|</span>
        <Bun />
        <span>|</span>
        <Biome />
        <span>|</span>
        <Typescript />
        <span>|</span>
        <Llama />
        <span>|</span>
        <GitHub gitIntegration={gitIntegration()} onOpenSettings={openGitSettings} />
        <span>|</span>
        <BunnyCloud />
        <span>|</span>
        <AnalyticsConsent />
        <span>|</span>
        <BunnyDash />
      </div>
    </div>
  );
};

const BunnyDash = () => {
  const channelText = () =>
    state.buildVars.channel === "stable" ? "" : `-${state.buildVars.channel}`;
  return (
    <div style={{ margin: "0 5px" }}>
      Bunny Dash{channelText()} v{state.buildVars.version} - {state.buildVars.hash}
    </div>
  );
};

const Bun = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Bun v{state.peerDependencies?.bun?.version || ""}
    </div>
  );
};

const Typescript = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Typescript v{state.peerDependencies?.typescript?.version || ""}
    </div>
  );
};

const Biome = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Biome v{state.peerDependencies?.biome?.version || ""}
    </div>
  );
};

const Git = (props: { onOpenSettings: () => void }) => {
  return (
    <div
      style={{ margin: "0 5px", cursor: "pointer" }}
      title="Open Git settings"
      onClick={props.onOpenSettings}
    >
      Git v{state.peerDependencies?.git?.version || ""}
    </div>
  );
};

const Homebrew = () => {
  return (
    <div style={{ margin: "0 5px" }}>
      Homebrew
    </div>
  );
};

const Workspace = () => {
  const getTotalTabs = () => {
    return Object.keys(getWindow()?.tabs || {}).length;
  };

  return (
    <div style={{ margin: "0 5px" }}>
      win: {state.workspace.windows.length} | tabs: {getTotalTabs()}
    </div>
  );
};

const Llama = () => {
  const [llamaStatus, setLlamaStatus] = createSignal<{
    version: string | null;
    isRunning: boolean;
    isInstalled: boolean;
    isPending: boolean;
    modelAvailable: boolean;
    modelCount: number;
  }>({
    version: "bundled",
    isRunning: true, // Bundled with app
    isInstalled: true, // Bundled with app
    isPending: false,
    modelAvailable: false,
    modelCount: 0,
  });

  const checkLlamaStatus = async () => {
    try {
      // Check available models via our new RPC
      const result = await invokeLlamaCarrot<any>("llamaListModels");
      if (result?.ok) {
        const modelCount = result.models.length;
        const modelAvailable = modelCount > 0;
        
        setLlamaStatus({
          version: "bundled",
          isRunning: true,
          isInstalled: true,
          isPending: false,
          modelAvailable,
          modelCount,
        });
      } else {
        console.log("StatusBar: RPC returned ok=false:", result);
        setLlamaStatus({
          version: "bundled",
          isRunning: true,
          isInstalled: true,
          isPending: false,
          modelAvailable: false,
          modelCount: 0,
        });
      }
    } catch (error) {
      console.error("StatusBar: Error calling llamaListModels:", error);
      setLlamaStatus({
        version: "bundled",
        isRunning: true,
        isInstalled: true,
        isPending: false,
        modelAvailable: false,
        modelCount: 0,
      });
    }
  };

  const handleLlamaClick = async () => {
    if (state.settingsPane.type === "llama-settings") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "llama-settings", data: {} });
    }
  };

  // Check status on mount and periodically
  onMount(() => {
    console.log("StatusBar: onMount called, starting checkLlamaStatus");
    // Delay the first check to ensure the main process is fully initialized
    setTimeout(() => {
      checkLlamaStatus();
    }, 2000);
    // Check every 30 seconds
    const interval = setInterval(checkLlamaStatus, 30000);
    return () => clearInterval(interval);
  });

  const getStatusText = () => {
    const status = llamaStatus();
    
    if (status.isPending) {
      return "llama.cpp (setting up...)";
    }
    
    if (!status.isInstalled || !status.isRunning) {
      return "llama.cpp (not running)";
    }
    
    if (!status.modelAvailable) {
      return "llama.cpp (model missing)";
    }
    
    return `llama.cpp v${status.version || 'unknown'} (${status.modelCount} models)`;
  };

  const getStatusColor = () => {
    const status = llamaStatus();
    
    if (status.isPending) {
      return "#ffa500"; // Orange for pending
    }
    
    if (!status.isInstalled || !status.isRunning || !status.modelAvailable) {
      return "#ff6b6b"; // Red for issues
    }
    
    return "#51cf66"; // Green for ready
  };

  const shouldShowSpinner = () => {
    const status = llamaStatus();
    const activeRequestsCount = aiCompletionService.getActiveRequestsCount();
    return status.isPending || activeRequestsCount() > 0;
  };

  return (
    <div 
      style={{ 
        margin: "0 5px", 
        color: getStatusColor(),
        cursor: "pointer",
        display: "flex",
        "align-items": "center",
        gap: "4px"
      }}
      onClick={handleLlamaClick}
      title="Click to open llama.cpp settings"
    >
      {shouldShowSpinner() && (
        <div 
          style={{
            width: "10px",
            height: "10px",
            border: "1px solid #666",
            "border-top": "1px solid #fff",
            "border-radius": "50%",
            animation: "spin 1s linear infinite"
          }}
        />
      )}
      <span>{getStatusText()}</span>
      <style>
        {`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        `}
      </style>
    </div>
  );
};

const GitHub = (props: {
  gitIntegration: GitIntegrationState | null;
  onOpenSettings: () => void;
}) => {

  const getStatusText = () => {
    const username =
      props.gitIntegration?.github?.user?.login || props.gitIntegration?.github?.username || "";
    if (props.gitIntegration?.github?.connected && username) {
      return `GitHub @${username}`;
    }
    return "GitHub";
  };

  const getStatusColor = () => {
    return props.gitIntegration?.github?.connected ? "#51cf66" : "#666";
  };

  return (
    <div
      style={{
        margin: "0 5px",
        color: getStatusColor(),
        cursor: "pointer",
        "white-space": "nowrap", // Prevent wrapping
        "font-size": "11px"
      }}
      onClick={props.onOpenSettings}
      title="Open Git & GitHub settings"
    >
      {getStatusText()}
    </div>
  );
};

const BunnyCloud = () => {
  const isConnected = () => {
    return state.appSettings.bunnyCloud?.accessToken && state.appSettings.bunnyCloud?.email;
  };

  const handleBunnyCloudClick = () => {
    if (state.settingsPane.type === "bunny-cloud-settings") {
      setState("settingsPane", { type: "", data: {} });
    } else {
      setState("settingsPane", { type: "bunny-cloud-settings", data: {} });
    }
  };

  const getStatusText = () => {
    if (isConnected()) {
      const displayName = state.appSettings.bunnyCloud.name || state.appSettings.bunnyCloud.email;
      return `Bunny Cloud: ${displayName}`;
    }
    return "Bunny Cloud";
  };

  const getStatusColor = () => {
    if (!isConnected()) return "#666"; // Gray if not connected
    if (!state.appSettings.bunnyCloud.emailVerified) return "#ffa500"; // Orange if email not verified
    return "#51cf66"; // Green if fully connected
  };

  return (
    <div
      style={{
        margin: "0 5px",
        color: getStatusColor(),
        cursor: "pointer",
        "white-space": "nowrap",
        "font-size": "11px"
      }}
      onClick={handleBunnyCloudClick}
      title={isConnected() ? "Bunny Cloud connected - click to open settings" : "Bunny Cloud - click to login"}
    >
      {getStatusText()}
    </div>
  );
};

const AnalyticsConsent = () => {
  const shouldShowConsent = () => {
    // Show if user hasn't been prompted yet
    return !state.appSettings.analyticsConsentPrompted;
  };

  const handleAnalyticsClick = () => {
    // Open global settings to analytics section
    setState("settingsPane", { type: "global-settings", data: {} });
  };

  if (!shouldShowConsent()) {
    return null;
  }

  return (
    <>
      <span>|</span>
      <div
        style={{
          margin: "0 5px",
          color: "#ffa500", // Orange to indicate action needed
          cursor: "pointer",
          "white-space": "nowrap",
          "font-size": "11px"
        }}
        onClick={handleAnalyticsClick}
        title="Click to enable analytics and help improve Bunny Dash"
      >
        Enable Analytics
      </div>
    </>
  );
};
