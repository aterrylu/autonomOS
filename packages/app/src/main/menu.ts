// Native macOS / Linux / Windows menu. Rebuilt whenever the connections
// list changes so File > Recent Servers stays in sync.

import { app, Menu, type MenuItemConstructorOptions } from "electron";

import { getConfig } from "./config/store.js";
import { openConnectionWindow, openWelcomeWindow } from "./window-manager.js";

export async function buildMenu(): Promise<void> {
  const config = await getConfig();
  const recent = config.connections;

  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const recentSubmenu: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: "No recent servers", enabled: false }]
      : recent.map((c) => ({
          label: c.name,
          click: () => openConnectionWindow(c.id),
        }));

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => openWelcomeWindow(),
        },
        {
          label: "Open Recent Server",
          submenu: recentSubmenu,
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
