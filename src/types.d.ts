// Global type declarations for the GoogleDocsRangeDiffs extension.

// Window properties injected by the MAIN world interceptor.
interface Window {
  __drRevisionStart: number | undefined;
  __drRevisionEnd: number | undefined;
  __drMaxRevision: number | undefined;
  showRevisions: (start: number, end: number) => void;
  openVersionHistory: () => boolean;
}

// Service worker globals used by background.ts.
// (importScripts is available in service workers but not in the DOM lib.)
declare function importScripts(...urls: string[]): void;
