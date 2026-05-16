/**
 * Bun + happy-dom helper for browser-click verification.
 *
 * happy-dom v20 parses inline <script> tags into the DOM but does not auto-
 * execute them inside Bun's runtime. We extract them and run them in a
 * Function() whose `document` / `window` / `Event` params shadow the globals,
 * so script code like `document.getElementById(...)` resolves to happy-dom's
 * DOM rather than Bun's globalThis.
 */
import { Browser } from "happy-dom";

export interface StaticPage {
  document: any;
  window: any;
  close(): Promise<void>;
}

export async function loadStaticHtml(html: string): Promise<StaticPage> {
  const browser = new Browser();
  const page = browser.newPage();
  page.content = html;
  await page.waitUntilComplete();
  const win = page.mainFrame.window as any;
  const doc = win.document as any;
  win.SyntaxError ||= SyntaxError;

  const scriptBody = Array.from(doc.getElementsByTagName("script") as Iterable<any>)
    .map((s: any) => s.textContent ?? "")
    .filter((t: string) => t.trim().length > 0)
    .join(";\n");
  if (scriptBody) {
    try {
      new Function(
        "document",
        "window",
        "Event",
        "localStorage",
        "sessionStorage",
        "crypto",
        "navigator",
        "location",
        scriptBody,
      )(
        doc,
        win,
        win.Event,
        win.localStorage,
        win.sessionStorage,
        win.crypto,
        win.navigator,
        win.location,
      );
    } catch (e) {
      // Re-throw with a clear marker so callers can show the bad script
      throw new Error(
        `loadStaticHtml: inline script threw: ${(e as Error).message}\nscript: ${scriptBody.slice(0, 200)}`,
      );
    }
  }

  return {
    document: doc,
    window: win,
    close: async () => {
      await browser.close();
    },
  };
}
