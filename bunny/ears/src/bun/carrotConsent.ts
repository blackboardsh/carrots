export async function requestCarrotUninstallConsent(name: string) {
  const { Utils } = await import("electrobun/bun");
  const { response } = await Utils.showMessageBox({
    type: "warning",
    title: `Uninstall ${name}?`,
    message: `Remove ${name} from Bunny Ears?`,
    detail: "This removes the installed payload and local runtime state for the Carrot.",
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });

  return response === 0;
}
