import { expect, test as base } from "@playwright/test";

const test = base.extend({
  opfsPage: async ({ browserName, page, playwright }, use, testInfo) => {
    if (browserName !== "chromium") {
      await use(page);
      return;
    }
    // Chromium deliberately caps an incognito origin at roughly 512 MiB.
    // Production and the Actual proof use a persistent profile, so exercise
    // the same quota model for the multi-gigabyte sparse-disk assertion.
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

async function supportsOPFSBlocks(page) {
  return await page.evaluate(
    () =>
      typeof navigator.storage?.getDirectory === "function" &&
      typeof navigator.locks?.request === "function",
  );
}

test("uses sparse multi-gigabyte OPFS block storage without materializing the disk", async ({
  opfsPage: page,
}) => {
  page.on("pageerror", (error) => console.error(`[browser] ${error.stack ?? error}`));
  await page.goto("/");
  test.skip(!(await supportsOPFSBlocks(page)), "browser does not expose OPFS and Web Locks");
  await expect.poll(() => page.evaluate(() => typeof globalThis.opfsBlockStorage)).toBe("function");
  expect(await page.evaluate(() => globalThis.opfsBlockStorage())).toEqual({
    capacity: 4 * 1024 ** 3,
    locked: "EBUSY",
    reads: [true, true, true],
    readBytes: 3 * 4096,
  });
});

test("maps OPFS quota exhaustion to ENOSPC", async ({ opfsPage: page }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.opfsBlockQuotaMapping))
    .toBe("function");
  expect(await page.evaluate(() => globalThis.opfsBlockQuotaMapping())).toBe("ENOSPC");
});
