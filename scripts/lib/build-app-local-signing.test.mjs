import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const helper = fileURLToPath(
  new URL("../../apps/macos/scripts/sign-local-app.sh", import.meta.url),
);
const entitlements = fileURLToPath(
  new URL("../../apps/macos/packaging/NodeRuntime.entitlements", import.meta.url),
);
const fixtures = [];
const macTest = process.platform === "darwin" ? test : test.skip;

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(process.env.CLAUDEXOR_TEST_TMPDIR ?? tmpdir(), "app-sign-"));
  fixtures.push(root);
  const app = join(root, "Claudexor.app");
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.claudexor.test</string>
<key>CFBundleExecutable</key><string>ClaudexorApp</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  const binary = join(macos, "ClaudexorApp");
  copyFileSync("/usr/bin/true", binary);
  chmodSync(binary, 0o755);
  const node = join(resources, "node");
  copyFileSync("/usr/bin/true", node);
  chmodSync(node, 0o755);
  const nestedSign = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--entitlements", entitlements, node],
    { encoding: "utf8" },
  );
  expect(nestedSign.status, nestedSign.stderr).toBe(0);
  writeFileSync(join(resources, "data.txt"), "sealed resource\n");
  return { root, app, node };
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

macTest("local signing seals app resources and preserves the nested Node signature", () => {
  const f = fixture();
  const nodeBefore = digest(f.node);
  const result = spawnSync("/bin/bash", [helper, f.app], { encoding: "utf8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(existsSync(join(f.app, "Contents", "_CodeSignature", "CodeResources"))).toBe(true);
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", f.app], {
    encoding: "utf8",
  });
  expect(verify.status, verify.stderr).toBe(0);
  expect(digest(f.node)).toBe(nodeBefore);
});

macTest("local signing fails when codesign fails", () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const fakeCodesign = join(bin, "codesign");
  writeFileSync(fakeCodesign, "#!/bin/sh\necho signing-failed >&2\nexit 71\n", { mode: 0o755 });
  chmodSync(fakeCodesign, 0o755);
  const result = spawnSync("/bin/bash", [helper, f.app], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(71);
  expect(result.stderr).toContain("signing-failed");
});

macTest("local signing fails when strict verification fails", () => {
  const f = fixture();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const fakeCodesign = join(bin, "codesign");
  writeFileSync(
    fakeCodesign,
    '#!/bin/sh\nif [ "$1" = "--verify" ]; then echo verification-failed >&2; exit 72; fi\nexit 0\n',
    { mode: 0o755 },
  );
  chmodSync(fakeCodesign, 0o755);
  const result = spawnSync("/bin/bash", [helper, f.app], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(72);
  expect(result.stderr).toContain("verification-failed");
});
