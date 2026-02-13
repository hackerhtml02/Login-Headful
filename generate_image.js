// generate_image.js
//
// ✔ Headful, Persistent Profile ("gemini_profile")
// ✔ ACCOUNT RESET: Deletes account -> Waits for "Agree" -> Clicks "Agree" -> Ready
// ✔ Fix: Handles "I understand" confirmation screen appearing TWICE
// ✔ Fix: Finds & Presses ENTER on 'identifierId' screen
// ✔ Smart Login: Detects "Sign in" button OR standard Email input
// ✔ INJECTED Auto-Clicker: Clicks 'Continue' button immediately inside browser
// ✔ Round Robin Monitoring for Blob/Errors
// ✔ NO RETRY: Skips scene if generation times out
// ✔ IMAGE MODE: Detects 'img' blob and saves as .png
// ✔ UPDATED: Press ENTER after Password detection
//
// ✅ UPDATE (Your Request):
// - Shadow-root safe click on menu item whose text is exactly/contains: "Generate images (Pro) 🍌"
// - Your provided XPath is NOT reliable for shadow DOM in Puppeteer, so we do a deep shadow traversal + text match click.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ========= ARG PARSE =========

const argMap = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split("=");
  if (k && typeof v !== "undefined") {
    argMap[k.replace(/^--/, "")] = v;
  }
}

// ========= CONFIG =========

const GEMINI_URL =
  "https://auth.business.gemini.google/account-chooser?continueUrl=https://business.gemini.google/";
const SETTINGS_URL = "https://business.gemini.google/settings/general";
const BLOB_PREFIX = "blob:https://business.gemini.google/";

const EMAIL =
  argMap.email || process.env.GEMINI_EMAIL || "1swzro22_354@latterlavender.cfd";
const PASSWORD =
  argMap.password || process.env.GEMINI_PASSWORD || "Haris123@";
const PROMPT_FILE = argMap.promptFile || process.env.PROMPT_FILE;

if (!PROMPT_FILE) {
  console.error("❌ No promptFile provided. Use --promptFile=prompts.txt");
  process.exit(1);
}

const OUTPUT_DIR =
  argMap.outputDir ||
  process.env.OUTPUT_DIR ||
  path.join(process.cwd(), "output_images");
const JOB_META_PATH = argMap.jobMeta || process.env.JOB_META_PATH || null;

// ** PROFILE SETTING **
const USER_DATA_DIR =
  argMap.userDataDir ||
  process.env.USER_DATA_DIR ||
  path.join(process.cwd(), "gemini_profile");

let maxTabs = parseInt(argMap.maxTabs || process.env.MAX_TABS || "1", 10);
if (isNaN(maxTabs) || maxTabs <= 0) maxTabs = 1;
if (maxTabs > 100) maxTabs = 100;

const HEADLESS =
  (argMap.headless || process.env.HEADLESS || "false").toLowerCase() === "true";
const BROWSER_PATH = argMap.browserPath || process.env.BROWSER_PATH || null;

// ========= HELPERS =========

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRandomFileName(sceneNumber) {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now();
  return `image_${sceneNumber}_${ts}_${rand}.png`;
}

function updateJobMeta(status, extra = {}) {
  if (!JOB_META_PATH) return;
  try {
    let meta = {};
    if (fs.existsSync(JOB_META_PATH)) {
      const raw = fs.readFileSync(JOB_META_PATH, "utf-8");
      meta = JSON.parse(raw);
    }
    meta.status = status;
    meta.finished_at = new Date().toISOString();
    Object.assign(meta, extra);
    fs.writeFileSync(JOB_META_PATH, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error("Failed to update job meta:", err);
  }
}

function loadPromptsFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`Prompt file not found: ${filePath}`);
    return [];
  }
  const data = fs.readFileSync(filePath, "utf-8");
  const prompts = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  console.log(`Loaded ${prompts.length} prompts from ${filePath}`);
  return prompts;
}

// ========= BROWSER UTILS (NATIVE XPATH) =========
// NOTE: XPath DOES NOT PIERCE shadowRoot. So we keep it only for non-shadow parts.

async function clickByXpath(page, xpath) {
  return page.evaluate((xp) => {
    const result = document.evaluate(
      xp,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    const el = result.singleNodeValue;
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, xpath);
}

async function typeByXpath(page, xpath, text) {
  return page.evaluate(
    ({ xp, txt }) => {
      const result = document.evaluate(
        xp,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const el = result.singleNodeValue;
      if (el) {
        el.value = txt;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { xp: xpath, txt: text }
  );
}

// ========= SHADOW DOM HELPERS =========

async function deepClickMenuItemByText(page, textToMatch) {
  // Finds md-menu-item anywhere (including shadow roots), checks innerText,
  // then clicks the most clickable child (div/li/button) OR the node itself.
  return page.evaluate((needle) => {
    function walkAllNodes(root) {
      const out = [];
      const visited = new Set();
      const queue = [root];

      while (queue.length) {
        const node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);
        out.push(node);

        // shadow root
        if (node.shadowRoot) queue.push(node.shadowRoot);

        // element children
        if (node.children && node.children.length) {
          for (const ch of node.children) queue.push(ch);
        }

        // shadow root children
        if (node.shadowRoot && node.shadowRoot.children && node.shadowRoot.children.length) {
          for (const ch of node.shadowRoot.children) queue.push(ch);
        }
      }
      return out;
    }

    function normalize(s) {
      return (s || "").replace(/\s+/g, " ").trim();
    }

    const all = walkAllNodes(document);
    const items = [];

    for (const n of all) {
      try {
        if (!n || !n.tagName) continue;
        if (String(n.tagName).toLowerCase() === "md-menu-item") items.push(n);
      } catch (_) {}
    }

    const targetText = normalize(needle);

    // 1) strict contains match
    let target = null;
    for (const it of items) {
      const txt = normalize(it.innerText || it.textContent || "");
      if (txt.includes(targetText)) {
        target = it;
        break;
      }
    }

    // 2) fallback: if nothing, try partial match by removing emoji
    if (!target) {
      const needleNoEmoji = targetText.replace(/[^\x00-\x7F]+/g, "").trim();
      if (needleNoEmoji) {
        for (const it of items) {
          const txt = normalize(it.innerText || it.textContent || "");
          const txtNoEmoji = txt.replace(/[^\x00-\x7F]+/g, "").trim();
          if (txtNoEmoji.includes(needleNoEmoji)) {
            target = it;
            break;
          }
        }
      }
    }

    if (!target) return { ok: false, reason: "menu_item_not_found", foundCount: items.length };

    // Try to click the most reliable clickable descendant
    const clickable =
      target.querySelector("div") ||
      target.querySelector("li") ||
      target.querySelector("button") ||
      target;

    try {
      clickable.click();
      return { ok: true, reason: "clicked", foundCount: items.length };
    } catch (e) {
      return { ok: false, reason: "click_failed", error: String(e), foundCount: items.length };
    }
  }, textToMatch);
}

// ========= ACCOUNT RESET LOGIC =========

async function handleAccountReset(page) {
  console.log("♻️ Checking Account State (Reset Check)...");

  try {
    await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
  } catch (e) {
    console.log("Nav error in reset check (ignored):", e.message);
  }

  await sleep(5000);
  const isAgreePresentInitial = await page.evaluate(() => {
    const btn = document.querySelector(".agree-button");
    if (btn) return true;
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.some((b) => (b.innerText || "").includes("Agree & get started"));
  });

  if (isAgreePresentInitial) {
    console.log("✅ 'Agree' button found initially. Clicking it...");
    await clickAgreeButton(page);
    return;
  }

  console.log("⚠️ 'Agree' button NOT found. Proceeding to DELETE Account...");

  // 2. Go to Settings
  await page.goto(SETTINGS_URL, { waitUntil: "networkidle2" });
  await sleep(5000);

  // 3. Click Delete Button
  const deleteBtnXpath =
    "/html/body/saas-settingsfe-root/main/saas-settingsfe-admin-page/mat-sidenav-container/mat-sidenav-content/saas-settingsfe-general-section/div/div[2]/div/div/button";

  const clickedDelete = await clickByXpath(page, deleteBtnXpath);
  if (!clickedDelete) {
    console.log("❌ Could not find Delete Button in Settings. Skipping reset.");
    return;
  }

  console.log("🗑️ Delete button clicked. Waiting for dialog...");
  await sleep(2000);

  // 4. Type "DELETE"
  const inputXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-content/form/mat-form-field/div[1]/div/div[2]/input";

  const typed = await typeByXpath(page, inputXpath, "DELETE");
  if (!typed) {
    console.log("❌ Could not find Delete Confirmation Input.");
    return;
  }

  console.log("✍️ Typed 'DELETE'.");
  await sleep(2000);

  // 5. Click Final "Delete account" Button
  const confirmBtnXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-actions/button[2]";

  const confirmed = await clickByXpath(page, confirmBtnXpath);
  if (confirmed) {
    console.log("✅ 'Delete account' clicked. Waiting for redirect...");
    await sleep(5000);

    // 🟢 AFTER DELETE: HANDLE AGREE BUTTON IMMEDIATELY 🟢
    console.log("🔄 Post-Delete: Checking for 'Agree & get started'...");
    await clickAgreeButton(page);
  } else {
    console.log("❌ Could not click Final Delete Button.");
  }
}

async function clickAgreeButton(page) {
  try {
    const agreeBtnClass = ".agree-button";
    if (await isElementPresent(page, agreeBtnClass, 5000)) {
      console.log("⚠️ 'Agree & get started' found via Class. Clicking...");
      await page.click(agreeBtnClass);
      await sleep(5000);
      await dismissWelcomeIfPresent(page);
      return true;
    }
    // Fallback Text Check
    const clickedByText = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) =>
        (b.innerText || "").includes("Agree & get started")
      );
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (clickedByText) {
      console.log("⚠️ 'Agree & get started' found via Text. Clicked.");
      await sleep(5000);
      await dismissWelcomeIfPresent(page);
      return true;
    }
  } catch (e) {
    console.log("Agree button check failed:", e.message);
  }
  return false;
}

// ========= LOGIN =========

async function isElementPresent(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch (_) {
    return false;
  }
}

async function dismissWelcomeIfPresent(page) {
  const clickLaterScript = () => {
    function clickWelcomeLater() {
      const app = document.querySelector("ucs-standalone-app");
      if (!app || !app.shadowRoot) return false;
      const welcome = app.shadowRoot.querySelector("ucs-welcome-dialog");
      if (!welcome || !welcome.shadowRoot) return false;
      const dlg = welcome.shadowRoot.querySelector("md-dialog");
      if (!dlg) return false;
      const mdButtons = dlg.querySelectorAll("md-text-button");
      for (const mdBtn of mdButtons) {
        let label = "";
        if (mdBtn.shadowRoot) {
          const innerBtn = mdBtn.shadowRoot.querySelector("button");
          if (innerBtn) label = innerBtn.innerText.trim();
        }
        if (!label) label = mdBtn.innerText.trim();
        if (label.includes("I'll do this later")) {
          let target = null;
          if (mdBtn.shadowRoot) {
            target = mdBtn.shadowRoot.querySelector("button") || mdBtn;
          } else {
            target = mdBtn;
          }
          if (target) {
            target.click();
            return true;
          }
        }
      }
      return false;
    }
    return clickWelcomeLater();
  };
  try {
    const laterClicked = await page.evaluate(clickLaterScript);
    if (laterClicked) {
      console.log("Clicked 'I'll do this later' dialog button.");
      await sleep(4000);
    }
  } catch (e) {
    // Ignore errors
  }
}

async function ensureLoggedInOnFirstTab(page) {
  console.log("Opening Gemini to check login status...");

  // 🔴 RETRY LOGIC FOR NAVIGATION
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
      break;
    } catch (err) {
      console.log(`⚠️ Navigation attempt ${i + 1} failed: ${err.message}`);
      await sleep(3000);
    }
  }

  await sleep(3000);
  // 🟢 PRIORITY 1: Check for "Agree" Button FIRST (Before Login) 🟢
  const agreeClicked = await clickAgreeButton(page);
  if (agreeClicked) {
    console.log("✅ Accepted 'Agree & get started'. Ready.");
    return;
  }

  // 1. Check for "Sign in" Session Button
  const signInXpath =
    "/html/body/c-wiz/div/div/div[1]/div/div[1]/div[3]/ul/li[1]/div/div/div[4]/span[1]/div/button";
  console.log("🔎 Checking for Saved Session 'Sign in' button...");

  const signInButtonClicked = await page.evaluate((xpath) => {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      const btn = result.singleNodeValue;
      if (btn) {
        btn.click();
        return true;
      }
      const allBtns = Array.from(document.querySelectorAll("button"));
      const fallback = allBtns.find(
        (b) =>
          (b.innerText || "").includes("Sign in") ||
          (b.getAttribute("aria-label") &&
            b.getAttribute("aria-label").includes("Sign in"))
      );
      if (fallback) {
        fallback.click();
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }, signInXpath);

  if (signInButtonClicked) {
    console.log(
      "✅ 'Sign in' button FOUND and CLICKED! Waiting for password field..."
    );
    await sleep(3000);
  } else {
    console.log("ℹ️ 'Sign in' button not found via XPath/Text.");
  }

  // 2. Determine next steps
  let needsEmailEntry = false;

  if (!signInButtonClicked) {
    const emailFieldPresent = await page.evaluate(
      () => !!document.querySelector("#email-input")
    );
    if (emailFieldPresent) {
      needsEmailEntry = true;
    } else {
      // Check if Dashboard is visible
      const isPromptAreaVisible = await page.evaluate(
        () => !!document.querySelector("ucs-standalone-app")
      );
      if (isPromptAreaVisible) {
        console.log("✅ Already logged in (Dashboard visible).");
      } else {
        console.log("ℹ️ No obvious login element found. Retrying email detection...");
        needsEmailEntry = true;
      }
    }
  }

  // === EMAIL ENTRY FLOW ===
  if (needsEmailEntry) {
    console.log("🔒 Starting Standard Email Login...");
    let loginSuccess = false;
    let attempt = 0;
    const maxAttempts = 5;
    while (!loginSuccess && attempt < maxAttempts) {
      attempt++;
      console.log(`\n🔄 Email Entry Attempt: ${attempt}`);
      try {
        const emailInput = await page.waitForSelector("#email-input", {
          timeout: 10000,
        });
        await emailInput.click();
        await page.evaluate((el) => (el.value = ""), emailInput);
        await emailInput.type(EMAIL);
        console.log("Email entered!");
        const continueBtn = await page.waitForSelector("#log-in-button", {
          timeout: 10000,
        });
        await continueBtn.click();
        console.log("Continue clicked. Waiting 15s for next screen...");
        await sleep(15000);

        // LOOK FOR IDENTIFIER ID
        try {
          const idInput = await page.waitForSelector("#identifierId", {
            timeout: 8000,
          });
          if (idInput) {
            console.log("✅ 'identifierId' found! Pressing Enter...");
            await idInput.press("Enter");
            await sleep(5000);
          }
        } catch (e) {}

        loginSuccess = true;
      } catch (err) {
        console.log(`Email entry error: ${err.message}`);
        await sleep(3000);
      }
    }
  }

  // === PASSWORD ENTRY FLOW (UPDATED: PRESS ENTER) ===
  if (signInButtonClicked || needsEmailEntry) {
    console.log("🔑 Waiting for Password field...");
    try {
      const passInput = await page.waitForSelector('input[name="Passwd"]', {
        timeout: 15000,
      });
      await passInput.click();
      await sleep(500);

      console.log("⌨️ Typing Password...");
      await passInput.type(PASSWORD);

      console.log("✅ Password entered. Pressing ENTER now...");
      await passInput.press("Enter");

      await sleep(8000);
    } catch (e) {
      console.log("ℹ️ Password field not found (maybe auto-logged in?):", e.message);
    }
  }

  // === CONFIRMATIONS ===
  console.log("Checking for confirmation screens...");
  for (let i = 1; i <= 2; i++) {
    try {
      const confirmSelector = 'input[value="I understand"], #confirm';
      if (await isElementPresent(page, confirmSelector, 5000)) {
        console.log(`⚠️ 'I understand' found (Occurrence ${i}). Clicking...`);
        await page.click(confirmSelector);
        await sleep(5000);
      } else {
        if (i === 1) break;
      }
    } catch (_) {}
  }

  // Final check for Agree button
  await clickAgreeButton(page);
  await dismissWelcomeIfPresent(page);
  console.log("✅ Ready to generate.");
}

// ========= CHECKS & AUTO-CLICKER INJECTION =========

async function findBlobUrlNow(page, prefix) {
  return page.evaluate((innerPrefix) => {
    const visited = new Set();
    const blobUrls = [];
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.querySelectorAll) {
        const imgs = node.querySelectorAll('img[src^="blob:"]');
        imgs.forEach((v) => {
          if (v.src && v.src.startsWith(innerPrefix)) {
            blobUrls.push(v.src);
          }
        });
      }
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
      if (node.childNodes && node.childNodes.length) {
        node.childNodes.forEach((child) => walk(child));
      }
    }
    walk(document);
    return blobUrls.length ? blobUrls[0] : null;
  }, prefix);
}

async function checkBannedError(page) {
  return page.evaluate(() => {
    const visited = new Set();
    let found = false;
    function walk(node) {
      if (found) return;
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.tagName && node.tagName.toLowerCase() === "ucs-banned-answer") {
        found = true;
        return;
      }
      if (node.shadowRoot) {
        walk(node.shadowRoot);
      }
      if (node.childNodes && node.childNodes.length) {
        node.childNodes.forEach((child) => walk(child));
      }
    }
    walk(document);
    return found;
  });
}

// ** AUTO-CLICKER **
async function injectAutoClicker(page) {
  console.log("💉 Injecting background auto-clicker into tab...");
  await page.evaluate(() => {
    window.autoClickerInterval = setInterval(() => {
      try {
        function deepQuery(root, matchFn) {
          if (!root) return null;
          const queue = [root];
          const visited = new Set();
          while (queue.length > 0) {
            const node = queue.shift();
            if (visited.has(node)) continue;
            visited.add(node);
            if (matchFn(node)) return node;
            if (node.shadowRoot) {
              const shadowChildren = node.shadowRoot.querySelectorAll("*");
              for (const child of shadowChildren) queue.push(child);
            }
            if (node.children) {
              for (const child of node.children) queue.push(child);
            }
          }
          return null;
        }
        const app = document.querySelector("ucs-standalone-app");
        if (!app) return;
        const conversation = deepQuery(
          app,
          (n) => n.tagName && n.tagName.toLowerCase() === "ucs-conversation"
        );
        if (!conversation) return;
        const mdButton = deepQuery(
          conversation,
          (n) => n.tagName && n.tagName.toLowerCase() === "md-filled-button"
        );
        if (!mdButton) return;
        let realBtn = null;
        if (mdButton.shadowRoot) {
          realBtn =
            mdButton.shadowRoot.getElementById("button") ||
            mdButton.shadowRoot.querySelector("button");
        } else {
          realBtn = mdButton.querySelector("button");
        }
        if (realBtn) realBtn.click();
      } catch (e) {}
    }, 500);
  });
}

// ========= FLOW =========

async function openToolsAndClickGenerate(page) {
  // 1) Open tools menu
  const menuOpened = await page.evaluate(() => {
    const app = document.querySelector("ucs-standalone-app");
    if (!app || !app.shadowRoot) return false;

    const landing = app.shadowRoot.querySelector("ucs-chat-landing");
    if (!landing || !landing.shadowRoot) return false;

    const landingRoot = landing.shadowRoot;
    const hostDiv = landingRoot.querySelector("div > div > div > div:nth-child(1)");
    if (!hostDiv) return false;

    const searchBar = hostDiv.querySelector("ucs-search-bar");
    if (!searchBar || !searchBar.shadowRoot) return false;

    const sbRoot = searchBar.shadowRoot;
    const form = sbRoot.querySelector("form");
    if (!form) return false;

    const mainDiv = form.querySelector("div");
    if (!mainDiv) return false;

    const toolsRow = mainDiv.querySelector("div.tools-button-container");
    if (!toolsRow) return false;

    const tooltipWrapper = toolsRow.querySelector(".tooltip-wrapper");
    if (!tooltipWrapper) return false;

    const btn = tooltipWrapper.querySelector("button, md-icon-button, md-text-button");
    if (!btn) return false;

    btn.click();
    return true;
  });

  if (!menuOpened) {
    console.log("⚠️ Tools menu not opened (maybe UI changed).");
  }

  await sleep(1500);

  // 2) Click EXACT menu item by text in shadow roots (Your required text)
  const TARGET_TEXT = "Generate images (Pro) 🍌";

  const res = await deepClickMenuItemByText(page, TARGET_TEXT);
  if (!res.ok) {
    console.log(
      `⚠️ Could not click menu item by text "${TARGET_TEXT}". Reason: ${res.reason}. Found md-menu-item count=${res.foundCount}`
    );

    // Fallback: try WITHOUT emoji
    const res2 = await deepClickMenuItemByText(page, "Generate images (Pro)");
    if (!res2.ok) {
      console.log(
        `⚠️ Fallback also failed. Reason: ${res2.reason}. Found md-menu-item count=${res2.foundCount}`
      );
    } else {
      console.log("✅ Fallback click success: 'Generate images (Pro)'.");
    }
  } else {
    console.log("✅ Clicked menu item: 'Generate images (Pro) 🍌'.");
  }

  await sleep(1500);
}

async function enterPromptAndSend(page, promptText) {
  const entered = await page.evaluate((text) => {
    const app = document.querySelector("ucs-standalone-app");
    if (!app || !app.shadowRoot) return false;

    const landing = app.shadowRoot.querySelector("ucs-chat-landing");
    if (!landing || !landing.shadowRoot) return false;

    const landingRoot = landing.shadowRoot;
    const hostDiv = landingRoot.querySelector("div > div > div > div:nth-child(1)");
    if (!hostDiv) return false;

    const searchBar = hostDiv.querySelector("ucs-search-bar");
    if (!searchBar || !searchBar.shadowRoot) return false;

    const sbRoot = searchBar.shadowRoot;
    const form = sbRoot.querySelector("form");
    if (!form) return false;

    const mainDiv = form.querySelector("div");
    if (!mainDiv) return false;

    const editorHost = mainDiv.querySelector("ucs-prosemirror-editor");
    if (!editorHost || !editorHost.shadowRoot) return false;

    const editorRoot = editorHost.shadowRoot;
    const p = editorRoot.querySelector("div > div > div > p");
    if (!p) return false;

    p.innerText = text;
    try {
      p.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch (_) {
      const evt = document.createEvent("HTMLEvents");
      evt.initEvent("input", true, true);
      p.dispatchEvent(evt);
    }
    return true;
  }, promptText);

  await sleep(800);

  const sent = await page.evaluate(() => {
    function qShadow(root, selector) {
      if (!root) return null;
      if (root.shadowRoot) return root.shadowRoot.querySelector(selector);
      return root.querySelector(selector);
    }

    const app = document.querySelector("ucs-standalone-app");
    if (!app) return false;

    const landing =
      qShadow(app, "ucs-chat-landing") || app.querySelector("ucs-chat-landing");
    if (!landing) return false;

    const landingRoot = landing.shadowRoot || landing;
    const hostDiv = landingRoot.querySelector("div > div > div > div:nth-child(1)");
    if (!hostDiv) return false;

    const searchBar =
      hostDiv.querySelector("ucs-search-bar") || qShadow(hostDiv, "ucs-search-bar");
    if (!searchBar) return false;

    const sbRoot = searchBar.shadowRoot || searchBar;
    const form = sbRoot.querySelector("form");
    if (!form) return false;

    const iconButtons = Array.from(form.querySelectorAll("md-icon-button"));
    if (!iconButtons.length) return false;

    const target =
      iconButtons.find((el) => {
        const ar = (el.getAttribute("aria-label") || "").toLowerCase();
        const title = (el.getAttribute("title") || "").toLowerCase();
        const txt = (el.innerText || "").toLowerCase();
        return (
          ar.includes("send") ||
          ar.includes("submit") ||
          ar.includes("search") ||
          title.includes("send") ||
          title.includes("submit") ||
          title.includes("search") ||
          txt.includes("send")
        );
      }) || iconButtons[iconButtons.length - 1];

    let clickTarget = target;
    if (target.shadowRoot) {
      clickTarget =
        target.shadowRoot.querySelector("button") ||
        target.shadowRoot.querySelector("md-ripple") ||
        target;
    } else {
      clickTarget =
        target.querySelector("button") ||
        target.querySelector("md-ripple") ||
        target;
    }
    if (!clickTarget) return false;

    clickTarget.click();
    return true;
  });

  return { entered, sent };
}

async function downloadBlobImage(page, blobUrl, outputFile) {
  console.log(`Downloading blob image for ${outputFile} ...`);
  const imageBase64 = await page.evaluate(async (url) => {
    const blob = await fetch(url).then((r) => r.blob());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        const base64 = res.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, blobUrl);

  const dirName = path.dirname(outputFile);
  fs.mkdirSync(dirName, { recursive: true });
  fs.writeFileSync(outputFile, Buffer.from(imageBase64, "base64"));
  console.log(`🎉 Image saved: ${outputFile}`);
}

// ========= MAIN =========

async function main() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const prompts = loadPromptsFromFile(PROMPT_FILE);
    if (!prompts.length) {
      console.log("No prompts loaded. Exiting.");
      updateJobMeta("failed", { reason: "no_prompts" });
      process.exit(1);
    }

    const total = prompts.length;
    console.log(`Total prompts: ${total}`);
    console.log(`Running in batches of max ${maxTabs} tabs.\n`);

    let globalIndex = 0;

    const launchOptions = {
      headless: HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-gpu",
        "--window-size=1280,720",
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--ignore-certificate-errors",
        "--allow-running-insecure-content",
      ],
      defaultViewport: { width: 1280, height: 720 },
    };
    if (BROWSER_PATH) launchOptions.executablePath = BROWSER_PATH;

    console.log(`📂 Using Profile Directory: ${USER_DATA_DIR}`);
    launchOptions.userDataDir = USER_DATA_DIR;

    console.log("Launching browser...");
    const browser = await puppeteer.launch(launchOptions);

    try {
      for (let start = 0; start < total; start += maxTabs) {
        const batchPrompts = prompts.slice(start, start + maxTabs);
        const batchNumber = Math.floor(start / maxTabs) + 1;
        console.log(
          `\n========= BATCH ${batchNumber} | Prompts ${start + 1} to ${
            start + batchPrompts.length
          } =========`
        );

        const pages = [];
        for (let i = 0; i < batchPrompts.length; i++) {
          const page = await browser.newPage();
          pages.push(page);
        }

        const firstPage = pages[0];
        if (firstPage) {
          console.log("⚡ Focus on first tab...");
          await firstPage.bringToFront();
        }

        // ============================================
        // 🔄 CHECK: 10 IMAGES ACCOUNT RESET LOGIC
        // ============================================
        if (start > 0 && start % 10 === 0) {
          console.log(
            `⚠️ 10 Images Threshold Reached (Current Index: ${start}). Performing Account Reset Check...`
          );
          await handleAccountReset(firstPage);
          await sleep(5000);
        }

        // Login Check (First Tab Only)
        await ensureLoggedInOnFirstTab(firstPage);

        console.log("Navigating all tabs to Gemini...");

        await Promise.all(
          pages.map(async (p) => {
            try {
              await p.goto(GEMINI_URL, { waitUntil: "networkidle2" });
            } catch (e) {
              console.log("Page nav retry (batch start)...");
              try {
                await p.goto(GEMINI_URL, { waitUntil: "networkidle2" });
              } catch (_) {}
            }
          })
        );
        await sleep(5000);

        const batchJobs = pages.map((page, idx) => ({
          page,
          prompt: batchPrompts[idx],
          sceneNumber: globalIndex + 1 + idx,
          finished: false,
          startTime: null,
        }));

        globalIndex += batchPrompts.length;
        console.log("🚀 Submitting prompts to all tabs...");

        await Promise.all(
          batchJobs.map(async (job) => {
            console.log(` [Image ${job.sceneNumber}] Submitting...`);
            try {
              await openToolsAndClickGenerate(job.page);
              await enterPromptAndSend(job.page, job.prompt);
              await injectAutoClicker(job.page);
              job.startTime = Date.now();
              console.log(
                ` [Image ${job.sceneNumber}] Submitted & Auto-Clicker active.`
              );
            } catch (e) {
              console.error(
                ` [Image ${job.sceneNumber}] Submit Failed:`,
                e.message
              );
              job.startTime = Date.now();
            }
          })
        );

        console.log("\n✅ All prompts submitted. Monitoring (Background)...");

        // Batch global timeout (10 mins)
        const batchTimeout = Date.now() + 600 * 1000;

        while (batchJobs.some((j) => !j.finished)) {
          if (Date.now() > batchTimeout) {
            console.log("⚠️ Batch timeout reached (10 mins). Moving on.");
            break;
          }

          let pendingCount = 0;
          for (const job of batchJobs) {
            if (job.finished) continue;
            pendingCount++;

            try {
              // 1. CHECK FOR BLOB (IMAGE)
              const blobUrl = await findBlobUrlNow(job.page, BLOB_PREFIX);
              if (blobUrl) {
                const durationSeconds = ((Date.now() - job.startTime) / 1000).toFixed(1);
                console.log(
                  `🎉 FOUND Image Blob for Image ${job.sceneNumber}: ${blobUrl}`
                );
                console.log(`⏱️ Time taken: ${durationSeconds} seconds`);

                const fileName = makeRandomFileName(job.sceneNumber);
                const outputFile = path.join(OUTPUT_DIR, fileName);

                await downloadBlobImage(job.page, blobUrl, outputFile);
                job.finished = true;
                continue;
              }

              // 2. CHECK FOR BANNED ANSWER ERROR
              const isBanned = await checkBannedError(job.page);
              if (isBanned) {
                console.log(
                  `❌ Image ${job.sceneNumber} FAILED: 'ucs-banned-answer' detected.`
                );
                job.finished = true;
                continue;
              }

              // 3. CHECK TIMEOUT (NO RETRY - JUST SKIP)
              const elapsed = Date.now() - job.startTime;
              const TIMEOUT_MS = 200000; // 200 seconds
              if (elapsed > TIMEOUT_MS) {
                console.log(
                  `⏩ Image ${job.sceneNumber} timed out (>200s). SKIPPING per instruction.`
                );
                job.finished = true;
                continue;
              }

              // Logging progress
              if (elapsed % 30000 < 5000) {
                console.log(
                  `⏳ Image ${job.sceneNumber}: Processing... (${(elapsed / 1000).toFixed(
                    0
                  )}s)`
                );
              }
            } catch (err) {
              console.log(`Error checking Image ${job.sceneNumber}:`, err.message);
            }
          }

          if (pendingCount === 0) break;
          if (!batchJobs.every((j) => j.finished)) await sleep(2000);
        }

        console.log(`=== Batch ${batchNumber} completed ===`);
        for (const p of pages) {
          try {
            await p.close();
          } catch (_) {}
        }
      }

      console.log("\n✅ All batches completed.");
      updateJobMeta("completed", { total_scenes: globalIndex });
      await browser.close();
      process.exit(0);
    } catch (err) {
      console.error("Error during batches:", err);
      updateJobMeta("failed", { error: String(err) });
      await browser.close();
      process.exit(1);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    updateJobMeta("failed", { error: String(err) });
    process.exit(1);
  }
}

main();
