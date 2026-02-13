// generate_image.js
// FIXED: Prompt typing in Shadow DOM ProseMirror using keyboard (CTRL+A + type)
// FIXED: Reliable "Send" click with deep shadow traversal
// NOTE: Keep your reset/login logic as-is, main change: enterPromptAndSend()

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

// ========= ARG PARSE =========
const argMap = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split("=");
  if (k && typeof v !== "undefined") argMap[k.replace(/^--/, "")] = v;
}

// ========= CONFIG =========
const GEMINI_URL =
  "https://auth.business.gemini.google/account-chooser?continueUrl=https://business.gemini.google/";
const SETTINGS_URL = "https://business.gemini.google/settings/general";
const BLOB_PREFIX = "blob:https://business.gemini.google/";

const EMAIL = argMap.email || process.env.GEMINI_EMAIL || "1swzro22_354@latterlavender.cfd";
const PASSWORD = argMap.password || process.env.GEMINI_PASSWORD || "Haris123@";
const PROMPT_FILE = argMap.promptFile || process.env.PROMPT_FILE;

if (!PROMPT_FILE) {
  console.error("❌ No promptFile provided. Use --promptFile=prompts.txt");
  process.exit(1);
}

const OUTPUT_DIR = argMap.outputDir || process.env.OUTPUT_DIR || path.join(process.cwd(), "output_images");
const JOB_META_PATH = argMap.jobMeta || process.env.JOB_META_PATH || null;
const USER_DATA_DIR = argMap.userDataDir || process.env.USER_DATA_DIR || path.join(process.cwd(), "gemini_profile");

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
    if (fs.existsSync(JOB_META_PATH)) meta = JSON.parse(fs.readFileSync(JOB_META_PATH, "utf-8"));
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
          const target = (mdBtn.shadowRoot && (mdBtn.shadowRoot.querySelector("button") || mdBtn)) || mdBtn;
          target.click();
          return true;
        }
      }
      return false;
    }
    return clickWelcomeLater();
  };

  try {
    const laterClicked = await page.evaluate(clickLaterScript);
    if (laterClicked) {
      console.log("Clicked 'I'll do this later'.");
      await sleep(3000);
    }
  } catch (_) {}
}

async function clickAgreeButton(page) {
  try {
    const agreeBtnClass = ".agree-button";
    if (await isElementPresent(page, agreeBtnClass, 4000)) {
      console.log("⚠️ Agree found. Clicking...");
      await page.click(agreeBtnClass);
      await sleep(4000);
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
      console.log("⚠️ Agree found via text. Clicked.");
      await sleep(4000);
      await dismissWelcomeIfPresent(page);
      return true;
    }
  } catch (e) {
    console.log("Agree check failed:", e.message);
  }
  return false;
}

// ========= ACCOUNT RESET LOGIC (same) =========
async function handleAccountReset(page) {
  console.log("♻️ Reset Check...");
  try {
    await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
  } catch (e) {}

  await sleep(4000);

  const isAgreePresentInitial = await page.evaluate(() => {
    const btn = document.querySelector(".agree-button");
    if (btn) return true;
    return Array.from(document.querySelectorAll("button")).some((b) =>
      (b.innerText || "").includes("Agree & get started")
    );
  });

  if (isAgreePresentInitial) {
    console.log("✅ Agree found initially.");
    await clickAgreeButton(page);
    return;
  }

  console.log("⚠️ Agree not found. Deleting account...");
  await page.goto(SETTINGS_URL, { waitUntil: "networkidle2" });
  await sleep(5000);

  const deleteBtnXpath =
    "/html/body/saas-settingsfe-root/main/saas-settingsfe-admin-page/mat-sidenav-container/mat-sidenav-content/saas-settingsfe-general-section/div/div[2]/div/div/button";

  const clickedDelete = await clickByXpath(page, deleteBtnXpath);
  if (!clickedDelete) return;

  await sleep(2000);

  const inputXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-content/form/mat-form-field/div[1]/div/div[2]/input";

  const typed = await typeByXpath(page, inputXpath, "DELETE");
  if (!typed) return;

  await sleep(1500);

  const confirmBtnXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-actions/button[2]";

  const confirmed = await clickByXpath(page, confirmBtnXpath);
  if (confirmed) {
    await sleep(6000);
    await clickAgreeButton(page);
  }
}

// ========= LOGIN (same style, short) =========
async function ensureLoggedInOnFirstTab(page) {
  console.log("🔐 Checking login...");
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
      break;
    } catch (e) {
      await sleep(2000);
    }
  }

  await sleep(3000);
  if (await clickAgreeButton(page)) return;

  const dashboard = await page.evaluate(() => !!document.querySelector("ucs-standalone-app"));
  if (dashboard) {
    console.log("✅ Dashboard visible.");
    await dismissWelcomeIfPresent(page);
    return;
  }

  // Email login
  try {
    const emailInput = await page.waitForSelector("#email-input", { timeout: 12000 });
    await emailInput.click();
    await page.evaluate((el) => (el.value = ""), emailInput);
    await emailInput.type(EMAIL);

    const continueBtn = await page.waitForSelector("#log-in-button", { timeout: 12000 });
    await continueBtn.click();
    await sleep(8000);

    // Password
    try {
      const passInput = await page.waitForSelector('input[name="Passwd"]', { timeout: 20000 });
      await passInput.click();
      await passInput.type(PASSWORD);
      await passInput.press("Enter");
      await sleep(8000);
    } catch (_) {}
  } catch (_) {}

  // Confirmations
  for (let i = 1; i <= 2; i++) {
    try {
      const confirmSelector = 'input[value="I understand"], #confirm';
      if (await isElementPresent(page, confirmSelector, 4000)) {
        await page.click(confirmSelector);
        await sleep(4000);
      } else {
        if (i === 1) break;
      }
    } catch (_) {}
  }

  await clickAgreeButton(page);
  await dismissWelcomeIfPresent(page);
  console.log("✅ Ready.");
}

// ========= CHECKS =========
async function findBlobUrlNow(page, prefix) {
  return page.evaluate((innerPrefix) => {
    const visited = new Set();
    const blobUrls = [];
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.querySelectorAll) {
        node.querySelectorAll('img[src^="blob:"]').forEach((img) => {
          if (img.src && img.src.startsWith(innerPrefix)) blobUrls.push(img.src);
        });
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) node.childNodes.forEach((c) => walk(c));
    }
    walk(document);
    return blobUrls[0] || null;
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
      if (node.tagName && node.tagName.toLowerCase() === "ucs-banned-answer") found = true;
      if (node.shadowRoot) walk(node.shadowRoot);
      if (node.childNodes) node.childNodes.forEach((c) => walk(c));
    }
    walk(document);
    return found;
  });
}

async function injectAutoClicker(page) {
  await page.evaluate(() => {
    window.autoClickerInterval = setInterval(() => {
      try {
        function deepFind(root, predicate) {
          const q = [root];
          const seen = new Set();
          while (q.length) {
            const n = q.shift();
            if (!n || seen.has(n)) continue;
            seen.add(n);
            if (predicate(n)) return n;
            if (n.shadowRoot) n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
            if (n.children) Array.from(n.children).forEach((x) => q.push(x));
          }
          return null;
        }

        const app = document.querySelector("ucs-standalone-app");
        if (!app) return;

        const btn = deepFind(app, (n) => {
          const t = (n.tagName || "").toLowerCase();
          if (t !== "md-filled-button") return false;
          const txt = (n.innerText || "").toLowerCase();
          return txt.includes("continue") || txt.includes("generate") || txt.includes("create");
        });

        if (!btn) return;
        let real = btn;
        if (btn.shadowRoot) real = btn.shadowRoot.querySelector("button") || btn;
        real.click();
      } catch (_) {}
    }, 500);
  });
}

// ========= FLOW: open tools =========
async function openToolsAndClickGenerate(page) {
  await page.evaluate(() => {
    const app = document.querySelector("ucs-standalone-app");
    if (!app?.shadowRoot) return false;
    const landing = app.shadowRoot.querySelector("ucs-chat-landing");
    if (!landing?.shadowRoot) return false;

    const hostDiv = landing.shadowRoot.querySelector("div > div > div > div:nth-child(1)");
    if (!hostDiv) return false;

    const searchBar = hostDiv.querySelector("ucs-search-bar");
    if (!searchBar?.shadowRoot) return false;

    const form = searchBar.shadowRoot.querySelector("form");
    if (!form) return false;

    const toolsRow = form.querySelector("div.tools-button-container");
    const btn = toolsRow?.querySelector(".tooltip-wrapper button, .tooltip-wrapper md-icon-button, .tooltip-wrapper md-text-button");
    if (!btn) return false;

    btn.click();
    return true;
  });

  await sleep(1500);

  await page.evaluate(() => {
    const visited = new Set();
    function walk(node, out) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.querySelectorAll) node.querySelectorAll("md-menu-item").forEach((x) => out.push(x));
      if (node.shadowRoot) walk(node.shadowRoot, out);
      if (node.childNodes) node.childNodes.forEach((c) => walk(c, out));
    }
    const items = [];
    walk(document, items);
    if (!items.length) return false;

    const targetText = "Generate images (Pro)";
    for (const it of items) {
      const txt = (it.innerText || "").trim();
      if (txt.includes(targetText)) {
        (it.querySelector("li") || it).click();
        return true;
      }
    }

    // fallback (3rd item)
    const idx = 2;
    if (items[idx]) {
      (items[idx].querySelector("li") || items[idx]).click();
      return true;
    }
    return false;
  });

  await sleep(1500);
}

// ========= ✅ FIXED: PROMPT ENTER (KEYBOARD) + SEND CLICK =========
async function focusEditorProseMirror(page) {
  // Focus ONLY the correct editor id
  const result = await page.evaluate(() => {
    function deepFind(root, predicate) {
      const q = [root];
      const seen = new Set();
      while (q.length) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          if (predicate(n)) return n;
        } catch (_) {}
        if (n.shadowRoot) n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
        if (n.children) Array.from(n.children).forEach((x) => q.push(x));
      }
      return null;
    }

    const app = document.querySelector("ucs-standalone-app");
    if (!app) return { ok: false, reason: "no_app" };

    const editorHost = deepFind(app, (n) => {
      return (
        n.tagName &&
        n.tagName.toLowerCase() === "ucs-prosemirror-editor" &&
        (n.id || "") === "agent-search-prosemirror-editor"
      );
    });

    if (!editorHost) return { ok: false, reason: "no_editor_host_id" };

    const root = editorHost.shadowRoot;
    if (!root) return { ok: false, reason: "no_shadowroot" };

    const pm = root.querySelector('div.ProseMirror[contenteditable="true"]');
    if (!pm) return { ok: false, reason: "no_prosemirror" };

    pm.scrollIntoView({ block: "center", behavior: "instant" });
    pm.focus();

    // Put caret at end
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    return { ok: true };
  });

  if (!result.ok) throw new Error(`Editor focus failed: ${result.reason}`);
  return true;
}

async function clickSendButtonDeep(page) {
  const clicked = await page.evaluate(() => {
    function deepFind(root, predicate) {
      const q = [root];
      const seen = new Set();
      while (q.length) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          if (predicate(n)) return n;
        } catch (_) {}
        if (n.shadowRoot) n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
        if (n.children) Array.from(n.children).forEach((x) => q.push(x));
      }
      return null;
    }

    const app = document.querySelector("ucs-standalone-app");
    if (!app) return false;

    // find md-icon-button or button with aria-label send/submit
    const btn = deepFind(app, (n) => {
      const tag = (n.tagName || "").toLowerCase();
      if (tag !== "md-icon-button" && tag !== "button") return false;

      const ar = (n.getAttribute?.("aria-label") || "").toLowerCase();
      const title = (n.getAttribute?.("title") || "").toLowerCase();
      const txt = (n.innerText || "").toLowerCase();

      // Gemini sometimes labels it "Send" / "Submit" / "Search"
      return (
        ar.includes("send") ||
        ar.includes("submit") ||
        ar.includes("search") ||
        title.includes("send") ||
        title.includes("submit") ||
        txt.includes("send")
      );
    });

    if (!btn) return false;

    let target = btn;
    if (btn.shadowRoot) target = btn.shadowRoot.querySelector("button") || btn;
    else target = btn.querySelector?.("button") || btn;

    target.click();
    return true;
  });

  return clicked;
}

async function enterPromptAndSend(page, promptText) {
  // 1) Focus the ProseMirror editor (shadow)
  await focusEditorProseMirror(page);
  await sleep(300);

  // 2) CTRL+A and type via keyboard (MOST reliable)
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await sleep(50);

  // clear by backspace (extra safety)
  await page.keyboard.press("Backspace");
  await sleep(80);

  await page.keyboard.type(promptText, { delay: 2 });
  await sleep(250);

  // 3) Click send (deep)
  const sent = await clickSendButtonDeep(page);

  // 4) Fallback: press Enter (sometimes submits)
  if (!sent) {
    console.log("⚠️ Send button not found. Falling back to ENTER...");
    await page.keyboard.press("Enter");
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
        for (let i = 0; i < batchPrompts.length; i++) pages.push(await browser.newPage());

        const firstPage = pages[0];
        if (firstPage) await firstPage.bringToFront();

        // Reset every 10
        if (start > 0 && start % 10 === 0) {
          console.log(`⚠️ 10 Images Threshold reached (${start}). Reset check...`);
          await handleAccountReset(firstPage);
          await sleep(5000);
        }

        // Login check first tab
        await ensureLoggedInOnFirstTab(firstPage);

        console.log("Navigating all tabs to Gemini...");
        await Promise.all(
          pages.map(async (p) => {
            try {
              await p.goto(GEMINI_URL, { waitUntil: "networkidle2" });
            } catch (e) {
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

        console.log("\n✅ Monitoring...");

        const batchTimeout = Date.now() + 600 * 1000; // 10 min
        while (batchJobs.some((j) => !j.finished)) {
          if (Date.now() > batchTimeout) {
            console.log("⚠️ Batch timeout reached. Moving on.");
            break;
          }

          for (const job of batchJobs) {
            if (job.finished) continue;

            try {
              const blobUrl = await findBlobUrlNow(job.page, BLOB_PREFIX);
              if (blobUrl) {
                const durationSeconds = ((Date.now() - job.startTime) / 1000).toFixed(1);
                console.log(`🎉 FOUND blob for Image ${job.sceneNumber} | ${durationSeconds}s`);

                const fileName = makeRandomFileName(job.sceneNumber);
                const outputFile = path.join(OUTPUT_DIR, fileName);
                await downloadBlobImage(job.page, blobUrl, outputFile);

                job.finished = true;
                continue;
              }

              const banned = await checkBannedError(job.page);
              if (banned) {
                console.log(`❌ Image ${job.sceneNumber} banned-answer.`);
                job.finished = true;
                continue;
              }

              const elapsed = Date.now() - job.startTime;
              const TIMEOUT_MS = 200000;
              if (elapsed > TIMEOUT_MS) {
                console.log(`⏩ Image ${job.sceneNumber} timeout (>200s). Skipping.`);
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
