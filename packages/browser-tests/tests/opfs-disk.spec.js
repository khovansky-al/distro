import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ browserName, page, playwright }, use, testInfo) => {
    if (browserName !== "chromium") {
      await use(page);
      return;
    }
    const context = await playwright.chromium.launchPersistentContext(
      testInfo.outputPath("persistent-profile"),
      { headless: true, args: ["--unlimited-storage"] },
    );
    const persistentPage = context.pages()[0] ?? (await context.newPage());
    try {
      await use(persistentPage);
    } finally {
      await context.close();
    }
  },
});

test("persists a virtio block device through an OPFS worker", async ({ page }) => {
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));

  await page.goto("/");
  test.skip(
    !(await page.evaluate(
      () =>
        typeof navigator.storage?.getDirectory === "function" &&
        typeof navigator.locks?.request === "function",
    )),
    "browser does not expose OPFS and Web Locks",
  );
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsWorkerDiskRoundTrip))
    .toBe("function");
  const result = await page.evaluate(() => globalThis.opfsWorkerDiskRoundTrip());

  expect(result.locked).toBe("EBUSY");
  expect(result.offset).toBeGreaterThan(256 * 1024 ** 2);
  expect(result.write.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.write.stderr).toBe("");
  expect(result.read.status).toEqual({ code: 0, signal: null, success: true });
  expect(result.read.stderr).toBe("");
  expect(result.read.stdout).toContain(result.marker);
});
