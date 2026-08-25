{
  basic-init,
  bytes,
  image,
  lib,
  kernel,
  linux-guest,
  pkgs,
  playwright,
  repository,
  site,
  websocket-relay,
}:

let
  source = ../../packages/browser-tests;

  legacyRoot =
    pkgs.runCommand "site-legacy-root.ext4"
      {
        nativeBuildInputs = [
          pkgs.e2fsprogs
          pkgs.fakeroot
        ];
      }
      ''
        mkdir root
        cp -a --no-preserve=ownership ${site.rootfs.root}/. root/
        chmod -R u+w root
        # Match install-lowland's filesystem skeleton. Empty mountpoints are
        # not represented by the package payload copied above, but the agent
        # needs them before it can move dev/proc/sys and mount run/tmp.
        mkdir -p root/boot root/dev root/mnt root/proc root/run root/sys root/tmp
        chmod 1777 root/tmp
        touch root/etc/lowland-installed
        printf '%s\n' preserved-before-growth > root/growth-marker
        truncate -s 64M "$out"
        fakeroot sh -c 'chown -R 0:0 root && exec mke2fs -q -t ext4 -d root -F -L LOWLAND_ROOT -m 0 "$1"' -- "$out"
      '';

  baseSuite = pkgs.runCommand "browser-tests" { } ''
    mkdir -p \
      $out/node_modules/@lowland/bytes \
      $out/node_modules/@lowland/kernel \
      $out/node_modules/@lowland/guest
    ${playwright.linkRuntime "$out"}
    cp ${source}/app.js $out/app.js
    cp ${source}/index.html $out/index.html
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${site.package}/static/*/opfs-disk-worker.js $out/opfs-disk-worker.js
    cp ${image.bootInitramfs} $out/boot.cpio
    cp ${basic-init.schedulerHandoffDisk} $out/scheduler-handoff.erofs
    cp ${basic-init.remoteMemoryDisk} $out/remote-vm.erofs
    cp ${basic-init.posixSpawnStressDisk} $out/posix-spawn-stress.erofs
    cp ${source}/server.js $out/server.js
    cp ${linux-guest.package.checks.tests.assets}/rootfs.erofs $out/rootfs.erofs
    mkdir $out/tests
    cp ${source}/tests/boot.spec.js $out/tests/
    cp ${source}/tests/opfs-disk.spec.js $out/tests/
    cp ${source}/tests/posix-spawn-stress.spec.js $out/tests/
    cp ${source}/tests/opfs-block.spec.js $out/tests/
    cp ${source}/tests/remote-memory.spec.js $out/tests/
    cp ${source}/tests/spawn-stress.spec.js $out/tests/
    cp ${source}/tests/virtio-fs.spec.js $out/tests/
    cp ${source}/tests/websocket-network.spec.js $out/tests/
    cp -r ${bytes}/. $out/node_modules/@lowland/bytes/
    cp -r ${kernel}/. $out/node_modules/@lowland/kernel/
    tar -xzf ${linux-guest.package}/package.tgz --strip-components=1 -C $out/node_modules/@lowland/guest
  '';

  suite = baseSuite // {
    checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
      (lib.genAttrs projects check)
      // {
        site-live = siteCheck;
        service-worker = serviceWorkerCheck;
      }
    );
  };

  projects = [
    "chromium"
    "firefox"
    "webkit"
  ];

  check =
    project:
    playwright.mkCheck {
      name = "browser-tests-${project}";
      suite = baseSuite;
      inherit project;
      environment.WEBSOCKET_RELAY = "${websocket-relay}/bin/lowland-websocket-relay";
    };

  siteSuite = pkgs.runCommand "site-browser-tests" { } ''
      mkdir -p $out/tests
      ${playwright.linkRuntime "$out"}
      cp ${source}/playwright.config.js $out/playwright.config.js
      cp ${source}/server.js $out/server.js
      cp ${source}/tests/site-live.spec.js $out/tests/site-live.spec.js
      cp -rL ${site.package}/. $out/
      cp ${legacyRoot} $out/legacy-root.ext4
      cp -rL ${site.bootFiles}/boot $out/legacy-boot
      find $out/legacy-boot -type f -printf '%P\n' | LC_ALL=C sort > $out/legacy-boot-manifest.txt
      # Production and previews fetch the independently published repository.
      # The integration test vendors the exact candidate repository so it can
      # validate an install before those packages have reached production.
      cp -rL ${repository} $out/apk
      # After installation the service worker controls the page, so Playwright's
      # page-level route cannot intercept guest fetches. Route only this test
      # artifact's package requests to the vendored candidate repository; the
      # production worker continues to fetch assets.low.land directly.
      substituteInPlace $out/service-worker.js \
        --replace-fail '  const { request } = event;' '  let { request } = event;' \
        --replace-fail '  const url = new URL(request.url);' '  let url = new URL(request.url);
    if (url.hostname === "assets.low.land" && url.pathname.startsWith("/apk/")) {
      request = new Request(new URL(url.pathname + url.search, location.origin), request);
      url = new URL(request.url);
    }'
  '';

  serviceWorkerSuite = pkgs.runCommand "service-worker-browser-tests" { } ''
    mkdir -p $out/tests
    ${playwright.linkRuntime "$out"}
    cp ${source}/playwright.config.js $out/playwright.config.js
    cp ${source}/server.js $out/server.js
    cp ${source}/app.js $out/app.js
    cp ${source}/tests/service-worker.spec.js $out/tests/service-worker.spec.js
    cp ${source}/index.html $out/index.html
    cp ${../../apps/site/service-worker.js} $out/service-worker.js
  '';

  siteCheck = playwright.mkCheck {
    name = "browser-tests-site-live";
    project = "chromium";
    suite = siteSuite;
  };
  serviceWorkerCheck = playwright.mkCheck {
    name = "browser-tests-service-worker";
    project = "chromium";
    suite = serviceWorkerSuite;
  };
in
assert playwright.assertCompatible (source + "/package.json");
suite
