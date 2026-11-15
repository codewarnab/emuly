import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("doctor distinguishes granted scopes, missing scope and API errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-cli-"));
  try {
    writeFileSync(join(directory, "gh"), `#!/bin/sh
case "$*" in
  '--version') echo 'gh version 2.104.0' ;;
  'auth status') exit 0 ;;
  'auth token') echo test-token ;;
  'api user --jq .login') echo octocat ;;
  'api -i user')
    if [ "$TEST_SCOPE" = network ]; then echo 'network unavailable' >&2; exit 1; fi
    echo "X-OAuth-Scopes: repo, $TEST_SCOPE"
    echo '{}'
    ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    for (const scope of ["codespace", "gist", "network"]) {
      const result = spawnSync(process.execPath, [resolve("emuly.mjs"), "doctor"], {
        encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_TOKEN: "", GITHUB_TOKEN: "", EMULY_DB: join(directory, "test.db"), TEST_SCOPE: scope },
      });
      const output = result.stdout + result.stderr;
      assert.match(output, /octocat \(active account/);
      assert.equal(result.status, scope === "codespace" ? 0 : 1, output);
      if (scope === "gist") assert.match(output, /lacks the codespace scope/);
      if (scope === "network") {
        assert.match(output, /network unavailable/);
        assert.doesNotMatch(output, /lacks the codespace scope/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
