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
