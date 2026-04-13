// Background service worker for the GoogleDocsDiffRange extension.
//
// Handles messages from the content script and injects MAIN world
// functions into Google Docs pages. Loads injected functions from
// background-injected.js via importScripts.
importScripts('background-injected.js');

chrome.runtime.onMessage.addListener(function(msg, sender) {
  // From Docs content script: inject the revision interceptor that
  // monkey-patches XHR/fetch to rewrite showrevision start/end params.
  if (msg.type === 'injectRevisionInterceptor' && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      func: revisionInterceptorFunc,
      world: 'MAIN'
    }).catch(function(err) {
      console.warn('[DiffRange] injectRevisionInterceptor failed for tab', sender.tab.id, ':', err.message);
    });
    return;
  }
});
