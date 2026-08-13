import { expect, test } from "@playwright/test";

test("fetches HTTP from Linux through a browser WebSocket and native TCP relay", async ({
  page,
}) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => typeof globalThis.websocketFetch)).toBe("function");
  const result = await page.evaluate(() => globalThis.websocketFetch());

  expect(result.stderr).toBe("");
  expect(result.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.stdout).toBe("hello from the browser WebSocket relay\n");
});

test("publishes a Linux HTTP server through the browser WebSocket relay", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.startPublishedHttp))
    .toBe("function");
  const relayPort = await page.evaluate(() => globalThis.startPublishedHttp());
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from a published WASM Linux server\n");
  } finally {
    await page.evaluate(() => globalThis.stopPublishedHttp());
  }
});
