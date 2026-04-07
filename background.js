// AiChatLens — Background Service Worker
// Minimal: sets default storage on install

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ panelCollapsed: false }, () => {
    console.log('[AiChatLens] Installed — default panel state set.');
  });
});
