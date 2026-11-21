import { test } from "node:test";
import assert from "node:assert/strict";
import { createUiReader, parseUi } from "../../phone/runner/ui-tree.mjs";

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="0" text="Tom &amp; Jerry &#10;2" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[40,100][1040,200]" />
<node index="1" text="" resource-id="" class="android.widget.ImageButton" package="com.example" content-desc="Back" clickable="true" enabled="true" bounds="[0,0][100,100]" />
<node index="2" text="Submit" resource-id="" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="false" bounds="[100,300][300,401]" />
<node index="3" text="Hidden" resource-id="" class="android.view.View" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][0,0]" />
</node></hierarchy>UI hierchary dumped to: /dev/tty`;

test("parseUi keeps useful visible nodes with a tap point, and all=1 keeps every node", () => {
  const tree = parseUi(XML)!;
  assert.equal(tree.package, "com.example");
  assert.equal(tree.rotation, 0);
  assert.deepEqual(tree.nodes, [
    { text: "Tom & Jerry \n2", id: "com.example:id/title", class: "TextView", bounds: [40, 100, 1040, 200], tap: [540, 150] },
    { desc: "Back", class: "ImageButton", bounds: [0, 0, 100, 100], tap: [50, 50], flags: ["clickable"] },
    { text: "Submit", class: "Button", bounds: [100, 300, 300, 401], tap: [200, 351], flags: ["clickable", "disabled"] },
  ]);
  assert.equal(parseUi(XML, { all: true })!.count, 5);
  assert.equal(parseUi("ERROR: null root node returned by UiTestAutomationBridge."), null);
});

test("the reader retries null root node, then fails with a hint", async () => {
  const replies = ["ERROR: null root node returned by UiTestAutomationBridge.", XML];
  const waits: number[] = [];
  const reader = createUiReader({ adb: async () => replies.shift()!, sleep: async (ms: number) => { waits.push(ms); } });
  const tree = await reader.read();
  assert.equal(tree.tries, 2);
  assert.equal(tree.count, 3);
  assert.deepEqual(waits, [300]);

  const failing = createUiReader({ adb: async () => { throw Object.assign(new Error("exit 1"), { stdout: "ERROR: null root node returned", stderr: "" }); },
    sleep: async () => {} });
  await assert.rejects(failing.read(), (error: Error & { status: number; code: string }) =>
    error.status === 503 && error.code === "ui_unavailable" && /null root node\) after 4 tries/.test(error.message) && /screenshot/.test(error.message));
});
