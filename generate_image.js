// generate_image.js
// FIXED: Reliable prompt typing inside Shadow DOM ProseMirror editor + robust Send click

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

// ⚠️ Don't hardcode creds in production
const EMAIL = argMap.email || process.env.GEMINI_EMAIL || "YOUR_EMAIL_HERE";
const PASSWORD = argMap.password || process.env.GEMINI_PASSWORD || "YOUR_PASSWORD_HERE";
const PROMPT_FILE = argMap.promptFile || process.env.PROMPT_FILE;

if (!PROMPT_FILE) {
  console.error("❌ No promptFile provided. Use --promptFile=prompts.txt");
  process.exit(1);
}

const OUTPUT_DIR =
  argMap.outputDir || process.env.OUTPUT_DIR || path.join(process.cwd(), "output_images");
const JOB_META_PATH = argMap.jobMeta || process.env.JOB_META_PATH || null;

// Profile dir
const USER_DATA_DIR =
  argMap.userDataDir || process.env.USER_DATA_DIR || path.join(process.cwd(), "gemini_profile");

let maxTabs = parseInt(argMap.maxTabs || process.env.MAX_TABS || "1", 10);
if (isNaN(maxTabs) || maxTabs <= 0) maxTabs = 1;
if (maxTabs > 100) maxTabs = 100;

const HEADLESS = (argMap.headless || process.env.HEADLESS || "false").toLowerCase() === "true";
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
      meta = JSON.parse(fs.readFileSync(JOB_META_PATH, "utf-8"));
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
async function clickByXpath(page, xpath) {
  return page.evaluate((xp) => {
    const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, xpath);
}

async function typeByXpath(page, xpath, text) {
  return page.evaluate(({ xp, txt }) => {
    const result = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const el = result.singleNodeValue;
    if (el) {
      el.value = txt;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, { xp: xpath, txt: text });
}

// ========= LOGIN HELPERS =========
async function isElementPresent(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch (_) {
    return false;
  }
}

// ===== Welcome Dialog Dismiss (same as your code) =====
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
  } catch (_) {}
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

    const clickedByText = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => (b.innerText || "").includes("Agree & get started"));
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

// ========= ACCOUNT RESET LOGIC (same as yours, kept) =========
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

  await page.goto(SETTINGS_URL, { waitUntil: "networkidle2" });
  await sleep(5000);

  const deleteBtnXpath =
    "/html/body/saas-settingsfe-root/main/saas-settingsfe-admin-page/mat-sidenav-container/mat-sidenav-content/saas-settingsfe-general-section/div/div[2]/div/div/button";

  const clickedDelete = await clickByXpath(page, deleteBtnXpath);
  if (!clickedDelete) {
    console.log("❌ Could not find Delete Button in Settings. Skipping reset.");
    return;
  }

  console.log("🗑️ Delete button clicked. Waiting for dialog...");
  await sleep(2000);

  const inputXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-content/form/mat-form-field/div[1]/div/div[2]/input";

  const typed = await typeByXpath(page, inputXpath, "DELETE");
  if (!typed) {
    console.log("❌ Could not find Delete Confirmation Input.");
    return;
  }

  console.log("✍️ Typed 'DELETE'.");
  await sleep(2000);

  const confirmBtnXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-actions/button[2]";

  const confirmed = await clickByXpath(page, confirmBtnXpath);
  if (confirmed) {
    console.log("✅ 'Delete account' clicked. Waiting for redirect...");
    await sleep(5000);
    console.log("🔄 Post-Delete: Checking for 'Agree & get started'...");
    await clickAgreeButton(page);
  } else {
    console.log("❌ Could not click Final Delete Button.");
  }
}

// ========= LOGIN =========
async function ensureLoggedInOnFirstTab(page) {
  console.log("Opening Gemini to check login status...");

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

  const agreeClicked = await clickAgreeButton(page);
  if (agreeClicked) {
    console.log("✅ Accepted 'Agree & get started'. Ready.");
    return;
  }

  // If already on dashboard, skip
  const isDashboard = await page.evaluate(() => !!document.querySelector("ucs-standalone-app"));
  if (isDashboard) {
    console.log("✅ Dashboard visible. Likely already logged in.");
    await dismissWelcomeIfPresent(page);
    return;
  }

  // Try standard email login fields (your flow)
  console.log("🔒 Starting Standard Email Login...");
  try {
    const emailInput = await page.waitForSelector("#email-input", { timeout: 10000 });
    await emailInput.click();
    await page.evaluate((el) => (el.value = ""), emailInput);
    await emailInput.type(EMAIL);
    console.log("Email entered!");

    const continueBtn = await page.waitForSelector("#log-in-button", { timeout: 10000 });
    await continueBtn.click();
    console.log("Continue clicked. Waiting...");
    await sleep(8000);

    // identifierId enter (if appears)
    try {
      const idInput = await page.waitForSelector("#identifierId", { timeout: 8000 });
      if (idInput) {
        console.log("✅ 'identifierId' found! Pressing Enter...");
        await idInput.press("Enter");
        await sleep(5000);
      }
    } catch (_) {}

    // Password
    console.log("🔑 Waiting for Password field...");
    try {
      const passInput = await page.waitForSelector('input[name="Passwd"]', { timeout: 20000 });
      await passInput.click();
      await sleep(500);
      await passInput.type(PASSWORD);
      console.log("✅ Password entered. Pressing ENTER...");
      await passInput.press("Enter");
      await sleep(8000);
    } catch (e) {
      console.log("ℹ️ Password field not found:", e.message);
    }
  } catch (e) {
    console.log("ℹ️ Email login elements not found:", e.message);
  }

  // Confirmations "I understand" up to 2 times
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

  await clickAgreeButton(page);
  await dismissWelcomeIfPresent(page);
  console.log("✅ Ready to generate.");
}

// ========= CHECKS & AUTO-CLICKER =========
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
          if (v.src && v.src.startsWith(innerPrefix)) blobUrls.push(v.src);
        });
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes && node.childNodes.length) node.childNodes.forEach((c) => walk(c));
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
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes && node.childNodes.length) node.childNodes.forEach((c) => walk(c));
    }
    walk(document);
    return found;
  });
}

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
            if (!node || visited.has(node)) continue;
            visited.add(node);
            if (matchFn(node)) return node;
            if (node.shadowRoot) {
              node.shadowRoot.querySelectorAll("*").forEach((x) => queue.push(x));
            }
            if (node.children) Array.from(node.children).forEach((x) => queue.push(x));
          }
          return null;
        }

        const app = document.querySelector("ucs-standalone-app");
        if (!app) return;

        const conversation = deepQuery(app, (n) => n.tagName && n.tagName.toLowerCase() === "ucs-conversation");
        if (!conversation) return;

        const mdButton = deepQuery(conversation, (n) => n.tagName && n.tagName.toLowerCase() === "md-filled-button");
        if (!mdButton) return;

        let realBtn = null;
        if (mdButton.shadowRoot) {
          realBtn = mdButton.shadowRoot.getElementById("button") || mdButton.shadowRoot.querySelector("button");
        } else {
          realBtn = mdButton.querySelector("button");
        }
        if (realBtn) realBtn.click();
      } catch (_) {}
    }, 500);
  });
}

// ========= TOOLS MENU =========
async function openToolsAndClickGenerate(page) {
  await page.evaluate(() => {
    const app = document.querySelector("ucs-standalone-app");
    if (!app || !app.shadowRoot) return false;
    const landing = app.shadowRoot.querySelector("ucs-chat-landing");
    if (!landing || !landing.shadowRoot) return false;

    const hostDiv = landing.shadowRoot.querySelector("div > div > div > div:nth-child(1)");
    if (!hostDiv) return false;

    const searchBar = hostDiv.querySelector("ucs-search-bar");
    if (!searchBar || !searchBar.shadowRoot) return false;

    const form = searchBar.shadowRoot.querySelector("form");
    if (!form) return false;

    const toolsRow = form.querySelector("div.tools-button-container");
    if (!toolsRow) return false;

    const tooltipWrapper = toolsRow.querySelector(".tooltip-wrapper");
    if (!tooltipWrapper) return false;

    const btn = tooltipWrapper.querySelector("button, md-icon-button, md-text-button");
    if (!btn) return false;

    btn.click();
    return true;
  });

  await sleep(1500);

  await page.evaluate(() => {
    function findMenuItemsInShadows() {
      const result = [];
      const visited = new Set();
      function walk(node) {
        if (!node || visited.has(node)) return;
        visited.add(node);
        if (node.querySelectorAll) node.querySelectorAll("md-menu-item").forEach((it) => result.push(it));
        if (node.shadowRoot) walk(node.shadowRoot);
        if (node.childNodes) node.childNodes.forEach((c) => walk(c));
      }
      walk(document);
      return result;
    }

    const items = findMenuItemsInShadows();
    if (!items.length) return false;

    const TARGET_TEXT = "Generate images (Pro)";
    for (const it of items) {
      const txt = (it.innerText || "").trim();
      if (txt.includes(TARGET_TEXT)) {
        (it.querySelector("li") || it).click();
        return true;
      }
    }

    // fallback
    const idx = 2;
    if (idx < items.length) {
      (items[idx].querySelector("li") || items[idx]).click();
      return true;
    }
    return false;
  });

  await sleep(1500);
}

// ========= ✅ FIXED: PROMPT ENTRY INSIDE SHADOW PROSEMIRROR =========
async function enterPromptAndSend(page, promptText) {
  const ok = await page.evaluate(async (text) => {
    // Deep helper to traverse shadow roots
    function deepFind(root, predicate) {
      const queue = [root];
      const visited = new Set();
      while (queue.length) {
        const node = queue.shift();
        if (!node || visited.has(node)) continue;
        visited.add(node);

        try {
          if (predicate(node)) return node;
        } catch (_) {}

        // push shadow children
        if (node.shadowRoot) {
          node.shadowRoot.querySelectorAll("*").forEach((c) => queue.push(c));
        }
        // push light DOM children
        if (node.querySelectorAll) {
          node.querySelectorAll("*").forEach((c) => queue.push(c));
        }
      }
      return null;
    }

    const app = document.querySelector("ucs-standalone-app");
    if (!app) return { ok: false, reason: "no_app" };

    // Find the editor host specifically
    const editorHost = deepFind(app, (n) => n.tagName && n.tagName.toLowerCase() === "ucs-prosemirror-editor");
    if (!editorHost) return { ok: false, reason: "no_editor_host" };

    const editorRoot = editorHost.shadowRoot || editorHost;
    const pm = editorRoot.querySelector('div.ProseMirror[contenteditable="true"]');
    if (!pm) return { ok: false, reason: "no_prosemirror_div" };

    // Focus editor
    pm.focus();

    // Select all existing text
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pm);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}

    // Insert text reliably
    let inserted = false;
    try {
      // works in many Chromium builds
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {
      inserted = false;
    }

    if (!inserted) {
      // fallback: manual set as paragraph
      pm.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = text;
      pm.appendChild(p);
    }

    // Dispatch input events so app detects changes
    pm.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    pm.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    pm.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: " " }));
    pm.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: " " }));

    // Find send/submit button (md-icon-button etc)
    const sendBtn = deepFind(app, (n) => {
      if (!n) return false;
      const tag = (n.tagName || "").toLowerCase();
      if (tag === "md-icon-button" || tag === "button" || tag === "md-filled-button") {
        const ar = (n.getAttribute && (n.getAttribute("aria-label") || "").toLowerCase()) || "";
        const title = (n.getAttribute && (n.getAttribute("title") || "").toLowerCase()) || "";
        const txt = ((n.innerText || "") + "").toLowerCase();
        // try common labels
        return (
          ar.includes("send") ||
          ar.includes("submit") ||
          ar.includes("generate") ||
          title.includes("send") ||
          title.includes("submit") ||
          txt.includes("send") ||
          txt.includes("submit")
        );
      }
      return false;
    });

    if (!sendBtn) return { ok: true, sent: false, reason: "no_send_button" };

    // Click the actual inner button if in shadow
    let clickTarget = sendBtn;
    if (sendBtn.shadowRoot) {
      clickTarget =
        sendBtn.shadowRoot.querySelector("button") ||
        sendBtn.shadowRoot.querySelector("#button") ||
        sendBtn.shadowRoot.querySelector("md-ripple") ||
        sendBtn;
    } else {
      clickTarget = sendBtn.querySelector?.("button") || sendBtn;
    }
    clickTarget.click();
    return { ok: true, sent: true };
  }, promptText);

  if (!ok || !ok.ok) {
    throw new Error(`Prompt entry failed: ${(ok && ok.reason) || "unknown"}`);
  }
}

// ========= DOWNLOAD BLOB IMAGE =========
async function downloadBlobImage(page, blobUrl, outputFile) {
  console.log(`Downloading blob image for ${outputFile} ...`);
  const imageBase64 = await page.evaluate(async (url) => {
    const blob = await fetch(url).then((r) => r.blob());
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, blobUrl);

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
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
      userDataDir: USER_DATA_DIR,
    };

    if (BROWSER_PATH) launchOptions.executablePath = BROWSER_PATH;

    console.log(`📂 Using Profile Directory: ${USER_DATA_DIR}`);
    console.log("Launching browser...");
    const browser = await puppeteer.launch(launchOptions);

    try {
      for (let start = 0; start < total; start += maxTabs) {
        const batchPrompts = prompts.slice(start, start + maxTabs);
        const batchNumber = Math.floor(start / maxTabs) + 1;

        console.log(
          `\n========= BATCH ${batchNumber} | Prompts ${start + 1} to ${start + batchPrompts.length} =========`
        );

        const pages = [];
        for (let i = 0; i < batchPrompts.length; i++) {
          pages.push(await browser.newPage());
        }

        const firstPage = pages[0];
        if (firstPage) await firstPage.bringToFront();

        // Reset each 10 images
        if (start > 0 && start % 10 === 0) {
          console.log(`⚠️ 10 Images Threshold Reached (Index: ${start}). Reset check...`);
          await handleAccountReset(firstPage);
          await sleep(5000);
        }

        await ensureLoggedInOnFirstTab(firstPage);

        console.log("Navigating all tabs to Gemini...");
        await Promise.all(
          pages.map(async (p) => {
            try {
              await p.goto(GEMINI_URL, { waitUntil: "networkidle2" });
            } catch (_) {
              try {
                await p.goto(GEMINI_URL, { waitUntil: "networkidle2" });
              } catch (_) {}
            }
          })
        );
        await sleep(4000);

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
              console.log(` [Image ${job.sceneNumber}] Submitted ✅`);
            } catch (e) {
              console.error(` [Image ${job.sceneNumber}] Submit Failed:`, e.message);
              job.startTime = Date.now();
            }
          })
        );

        console.log("\n✅ All prompts submitted. Monitoring...");

        const batchTimeout = Date.now() + 600 * 1000; // 10 minutes
        while (batchJobs.some((j) => !j.finished)) {
          if (Date.now() > batchTimeout) {
            console.log("⚠️ Batch timeout reached (10 mins). Moving on.");
            break;
          }

          for (const job of batchJobs) {
            if (job.finished) continue;

            try {
              const blobUrl = await findBlobUrlNow(job.page, BLOB_PREFIX);
              if (blobUrl) {
                const durationSeconds = ((Date.now() - job.startTime) / 1000).toFixed(1);
                console.log(`🎉 FOUND Image Blob for Image ${job.sceneNumber}`);
                console.log(`⏱️ Time taken: ${durationSeconds}s`);

                const fileName = makeRandomFileName(job.sceneNumber);
                const outputFile = path.join(OUTPUT_DIR, fileName);
                await downloadBlobImage(job.page, blobUrl, outputFile);

                job.finished = true;
                continue;
              }

              const isBanned = await checkBannedError(job.page);
              if (isBanned) {
                console.log(`❌ Image ${job.sceneNumber} FAILED: banned answer detected.`);
                job.finished = true;
                continue;
              }

              const elapsed = Date.now() - job.startTime;
              const TIMEOUT_MS = 200000; // 200 seconds
              if (elapsed > TIMEOUT_MS) {
                console.log(`⏩ Image ${job.sceneNumber} timed out (>200s). SKIPPING.`);
                job.finished = true;
                continue;
              }
            } catch (err) {
              console.log(`Error checking Image ${job.sceneNumber}:`, err.message);
            }
          }

          await sleep(2000);
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
