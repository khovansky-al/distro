import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ playwright }, use, testInfo) => {
    // The production path is a persistent browsing profile. Chromium's normal
    // Playwright test context is incognito and imposes a 512 MiB origin quota,
    // which cannot represent even the minimum supported installation disk.
    const context = await playwright.chromium.launchPersistentContext(
      testInfo.outputPath("persistent-profile"),
      { headless: true, args: ["--unlimited-storage"] },
    );
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await use(page);
    } finally {
      await context.close();
    }
  },
});

async function waitForGuest(page, timeout = 30_000) {
  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout });
  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    "until grep -q ' /boot virtiofs ' /proc/mounts; do sleep 1; done; printf 'boot-%s\\n' mounted",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("boot-mounted", { timeout });
  return { input, terminal };
}

test("boots and formats a blank persistent disk into the canonical system", async ({ page }) => {
  test.setTimeout(300_000);
  const rootfsRequests = [];
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  page.on("request", (request) => {
    if (/\/rootfs-[^/]+\.erofs$/.test(new URL(request.url()).pathname)) {
      rootfsRequests.push(request.headers());
    }
  });
  await page.route("https://assets.low.land/apk/**", async (route) => {
    const requested = new URL(route.request().url());
    const local = new URL(requested.pathname + requested.search, page.url());
    const response = await page.request.get(local.href);
    await route.fulfill({ response });
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "estimate", {
      value: async () => ({ quota: 20 * 1024 ** 3, usage: 0 }),
    });
  });
  await page.goto("/?webgl=0&diskGiB=4");
  const diskStatus = page.evaluate(
    () =>
      new Promise((resolve) =>
        addEventListener("lowland:disk-status", (event) => resolve(event.detail), { once: true }),
      ),
  );
  await page.locator("#provision-disk").click();
  const openedDisks = await diskStatus;
  expect(openedDisks.mode).toBe("live");
  expect(openedDisks.rootCapacity).toBeGreaterThan(0);
  expect(openedDisks.provisioningDiskGiB).toBe(4);
  expect(openedDisks.installCapacity).toBe(4 * 1024 ** 3);
  const { input, terminal } = await waitForGuest(page, 180_000);
  await input.pressSequentially(
    "printf 'overlay-%s\\n' write-ok > /live-write-test; cat /live-write-test",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("overlay-write-ok");

  await input.pressSequentially("mount | grep ' on / type overlay'");
  await input.press("Enter");
  await expect(terminal).toContainText("on / type overlay");

  await input.pressSequentially(
    "magic=$(dd if=/dev/vdb bs=1 skip=1080 count=2 2>/dev/null | od -An -tx1 | tr -d ' \\n'); test -b /dev/vdb && test \"$magic\" != 53ef && printf 'install-disk-%s\\n' blank",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("install-disk-blank");

  await input.pressSequentially("install-lowland");
  await input.press("Enter");
  await expect(terminal).toContainText("Installation complete.", { timeout: 120_000 });

  const liveRootfsRequests = rootfsRequests.length;
  await page.reload();
  const { input: installedInput, terminal: installedTerminal } = await waitForGuest(page);
  await installedInput.pressSequentially(
    "mount | grep ' on / type ext4 (rw'; test \"$HOME\" = /root && test -d /root; printf 'installed-root-%s\\n' ready",
  );
  await installedInput.press("Enter");
  await expect(installedTerminal).toContainText("on / type ext4 (rw", { timeout: 15_000 });
  await expect(installedTerminal).toContainText("installed-root-ready");

  await installedInput.pressSequentially(
    "printf user-customized > /boot/index.html; apk --allow-untrusted fix --reinstall lowland-boot; grep -qx user-customized /boot/index.html && test -f /boot/index.html.apk-new && printf 'protected-boot-%s\\n' ok",
  );
  await installedInput.press("Enter");
  await expect(installedTerminal).toContainText("protected-boot-ok", { timeout: 60_000 });

  expect(rootfsRequests).toHaveLength(liveRootfsRequests);
  expect(rootfsRequests.some((headers) => headers.range?.startsWith("bytes="))).toBe(true);
});

test("falls back to live-only mode when persistent storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, "getDirectory", {
      configurable: true,
      value: async () => {
        throw new DOMException("Security error when calling GetDirectory", "SecurityError");
      },
    });
  });

  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto("/?webgl=0");

  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });
  await expect(terminal).not.toContainText("install-lowland");

  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    "! grep -qw 'lowland.install=1' /proc/cmdline && ! grep -q ' /boot virtiofs ' /proc/mounts && printf 'live-only-%s\\n' ready",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("live-only-ready");
  expect(dialogs).toEqual([]);
});

test("grows a legacy OPFS ext4 disk and preserves its files", async ({ page }) => {
  test.setTimeout(300_000);
  page.on("pageerror", (error) => console.log(`browser error: ${error.stack ?? error}`));
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "estimate", {
      value: async () => ({ quota: 20 * 1024 ** 3, usage: 0 }),
    });
  });
  await page.goto("/service-worker.js?legacy-setup=1");
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const disk = await root.getFileHandle("root.ext4", { create: true });
    const diskWriter = await disk.createWritable();
    const diskResponse = await fetch("/legacy-root.ext4");
    if (!diskResponse.ok || !diskResponse.body)
      throw new Error("legacy disk fixture is unavailable");
    await diskResponse.body.pipeTo(diskWriter);

    const boot = await root.getDirectoryHandle("boot", { create: true });
    const manifest = await fetch("/legacy-boot-manifest.txt").then((response) => response.text());
    for (const path of manifest.trim().split("\n")) {
      const parts = path.split("/");
      const name = parts.pop();
      let directory = boot;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part, { create: true });
      }
      const target = await directory.getFileHandle(name, { create: true });
      const writer = await target.createWritable();
      const response = await fetch(`/legacy-boot/${path}`);
      if (!response.ok || !response.body) throw new Error(`legacy boot fixture is missing ${path}`);
      await response.body.pipeTo(writer);
    }
  });

  await page.goto("/?live=1&webgl=0&diskGiB=4");
  await expect(page.locator("#provisioning-message")).toContainText("64 MiB installation");
  await page.locator("#provision-disk").click();
  // The recovery guest has a shell prompt too, but the page owns e2fsck and
  // resize2fs and then replaces itself with the installed boot. Do not type a
  // probe into the short-lived recovery console.
  await expect
    .poll(() => new URL(page.url()).searchParams.has("live"), { timeout: 180_000 })
    .toBe(false);
  const { input, terminal } = await waitForGuest(page, 180_000);
  await input.pressSequentially(
    "grep -qx preserved-before-growth /growth-marker && mount | grep ' on / type ext4 (rw' && test $(df -k / | awk 'NR==2 {print $2}') -gt 3000000 && printf 'legacy-growth-%s\\n' preserved",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("legacy-growth-preserved", { timeout: 30_000 });
  expect(
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      try {
        await root.getFileHandle("root.ext4.pre-grow");
        return false;
      } catch (error) {
        return error instanceof DOMException && error.name === "NotFoundError";
      }
    }),
  ).toBe(true);
});

test("embedded mode boots ephemerally without service-worker or persistent storage", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.lowlandEvents = [];
    for (const type of ["boot-status", "publication-opened", "publication-closed", "fatal"]) {
      addEventListener(`lowland:${type}`, (event) =>
        window.lowlandEvents.push({ type, detail: event.detail }),
      );
    }
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, "register", {
        value: () => {
          throw new Error("embedded mode registered a service worker");
        },
      });
    }
    Object.defineProperty(navigator.storage, "getDirectory", {
      value: () => {
        throw new Error("embedded mode opened persistent storage");
      },
    });
  });

  await page.goto("/?embed=1&webgl=0");
  const terminal = page.locator(".xterm-rows");
  await expect(terminal).toContainText("root@lowland", { timeout: 30_000 });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.lowlandEvents.some(
          (event) => event.type === "boot-status" && event.detail.status === "ready",
        ),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === "function"),
  ).toBe(true);
  expect(
    await page.evaluate(() => window.lowlandEvents.some((event) => event.type === "fatal")),
  ).toBe(false);

  const input = page.locator(".xterm-helper-textarea");
  await input.pressSequentially(
    "mount | grep ' on / type overlay' >/dev/null && ! grep -q ' /boot virtiofs ' /proc/mounts && test ! -b /dev/vdc && printf 'embedded-%s\\n' ephemeral",
  );
  await input.press("Enter");
  await expect(terminal).toContainText("embedded-ephemeral");
});
