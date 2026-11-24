import puppeteer from "@cloudflare/puppeteer";
import { clearMessageCache, getMessage } from "./guestbook";
import type { Environment } from "../types";

const MAX_SHARE_CARDS = 5_000;
const MAX_SHARE_CARD_BYTES = 256 * 1024;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function createCardHtml(name: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 1200px; height: 630px; margin: 0; }
    body {
      display: grid;
      place-items: center;
      padding: 42px;
      background: #edf3ef;
      color: #123940;
      font-family: Arial, sans-serif;
    }
    main {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 58px 64px;
      border: 1px solid #c9d7d1;
      border-radius: 28px;
      background: #fbfdf9;
    }
    .brand { display: flex; align-items: center; gap: 14px; font-size: 21px; font-weight: 700; }
    .mark { width: 34px; height: 34px; border-radius: 12px; background: #123940; position: relative; }
    .mark::after { content: ""; position: absolute; width: 12px; height: 12px; left: 10px; top: 10px; border: 2px solid #d7f46b; border-radius: 50%; }
    .kicker { margin: 0 0 20px; color: #667d7b; font-size: 16px; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0 0 20px; font-size: 38px; line-height: 1.1; }
    .message { margin: 0; color: #31575b; font-size: 31px; line-height: 1.35; overflow-wrap: anywhere; white-space: pre-wrap; }
    footer { display: flex; justify-content: space-between; align-items: center; color: #667d7b; font-size: 16px; }
    .dot { width: 10px; height: 10px; display: inline-block; margin-right: 8px; border-radius: 50%; background: #f1a28b; vertical-align: 1px; }
  </style>
  <body>
    <main>
      <div class="brand"><span class="mark"></span><span>passing place</span></div>
      <section>
        <p class="kicker">A little note from</p>
        <h1>${escapeHtml(name)}</h1>
        <p class="message">${escapeHtml(message)}</p>
      </section>
      <footer><span><span class="dot"></span>One small stop on the internet</span><span>passing-place</span></footer>
    </main>
  </body>
</html>`;
}

export async function generateShareCard(
  env: Environment,
  messageId: string,
): Promise<string | null> {
  const entry = await getMessage(env, messageId);
  if (!entry || entry.status !== "approved") return null;
  if (entry.share_card_key) return entry.share_card_key;

  const cardCount = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM messages WHERE share_card_key IS NOT NULL",
  ).all<{ total: number }>();
  if ((cardCount.results[0]?.total ?? 0) >= MAX_SHARE_CARDS) return null;

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.setContent(createCardHtml(entry.name, entry.message), {
      waitUntil: "domcontentloaded",
    });
    const screenshot = await page.screenshot({ type: "jpeg", quality: 78 });
    const bytes = new Uint8Array(screenshot.byteLength);
    bytes.set(screenshot);
    if (bytes.byteLength > MAX_SHARE_CARD_BYTES) {
      console.warn("Skipped an oversized guestbook share card", messageId);
      return null;
    }

    const key = `share-cards/${messageId}.jpg`;
    await env.PHOTOS.put(key, bytes, {
      httpMetadata: { contentType: "image/jpeg" },
    });
    const update = await env.DB.prepare(
      "UPDATE messages SET share_card_key = ? WHERE id = ? AND status = 'approved' AND share_card_key IS NULL AND (SELECT COUNT(*) FROM messages AS cards WHERE cards.share_card_key IS NOT NULL) < ?",
    )
      .bind(key, messageId, MAX_SHARE_CARDS)
      .run();

    if (update.meta.changes !== 1) {
      const current = await getMessage(env, messageId);
      if (current?.share_card_key) return current.share_card_key;
      await env.PHOTOS.delete(key);
      return null;
    }

    await clearMessageCache(env);

    return key;
  } finally {
    await browser.close();
  }
}
