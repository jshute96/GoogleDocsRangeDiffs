// Background service worker for the GoogleDocsDiffRange extension.
//
// Handles messages from the content script and injects MAIN world
// functions into Google Docs pages. Loads injected functions from
// background-injected.js via importScripts.
importScripts('background-injected.js');

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://github.com/jshute96/GoogleDocsDiffRange/blob/main/README.md' });
});

chrome.runtime.onMessage.addListener((msg: { type: string }, sender: chrome.runtime.MessageSender) => {
  // From Docs content script: inject the revision interceptor that
  // monkey-patches XHR/fetch to rewrite showrevision start/end params.
  if (msg.type === 'injectRevisionInterceptor' && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    chrome.scripting.executeScript({
      target: { tabId },
      func: revisionInterceptorFunc,
      world: 'MAIN'
    }).catch((err: Error) => {
      console.warn('[DiffRange] injectRevisionInterceptor failed for tab', tabId, ':', err.message);
    });
  }
});
