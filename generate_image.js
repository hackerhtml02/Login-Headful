// generate_image.js
// ✅ FIX: Works even when UI structure changes (no ucs-chat-landing / no searchbar shadow assumptions)
// ✅ Finds ProseMirror contenteditable by deep shadow traversal
// ✅ Clicks Submit button inside md-icon-button shadowRoot by deep shadow traversal

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

// ========= XPATH UTILS =========
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
  try {
    await page.evaluate(() => {
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
    });
    await sleep(2500);
  } catch (_) {}
}

async function clickAgreeButton(page) {
  try {
    if (await isElementPresent(page, ".agree-button", 4000)) {
      await page.click(".agree-button");
      await sleep(4000);
      await dismissWelcomeIfPresent(page);
      return true;
    }

    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => (b.innerText || "").includes("Agree & get started"));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      await sleep(4000);
      await dismissWelcomeIfPresent(page);
      return true;
    }
  } catch (_) {}
  return false;
}

// ========= ACCOUNT RESET (kept minimal) =========
async function handleAccountReset(page) {
  console.log("♻️ Reset Check...");
  try {
    await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
  } catch (_) {}
  await sleep(4000);

  const agree = await page.evaluate(() => {
    if (document.querySelector(".agree-button")) return true;
    return Array.from(document.querySelectorAll("button")).some((b) =>
      (b.innerText || "").includes("Agree & get started")
    );
  });

  if (agree) {
    console.log("✅ Agree found.");
    await clickAgreeButton(page);
    return;
  }

  console.log("⚠️ Agree not found. Deleting account...");
  await page.goto(SETTINGS_URL, { waitUntil: "networkidle2" });
  await sleep(5000);

  const deleteBtnXpath =
    "/html/body/saas-settingsfe-root/main/saas-settingsfe-admin-page/mat-sidenav-container/mat-sidenav-content/saas-settingsfe-general-section/div/div[2]/div/div/button";

  if (!(await clickByXpath(page, deleteBtnXpath))) return;

  await sleep(2000);

  const inputXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-content/form/mat-form-field/div[1]/div/div[2]/input";

  if (!(await typeByXpath(page, inputXpath, "DELETE"))) return;

  await sleep(1500);

  const confirmBtnXpath =
    "/html/body/div[2]/div/div[2]/mat-dialog-container/div/div/delete-agentspace-dialog/mat-dialog-actions/button[2]";

  if (await clickByXpath(page, confirmBtnXpath)) {
    await sleep(6000);
    await clickAgreeButton(page);
  }
}

// ========= LOGIN =========
async function ensureLoggedInOnFirstTab(page) {
  console.log("🔐 Checking login...");
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
      break;
    } catch (_) {
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

  try {
    const emailInput = await page.waitForSelector("#email-input", { timeout: 12000 });
    await emailInput.click();
    await page.evaluate((el) => (el.value = ""), emailInput);
    await emailInput.type(EMAIL);

    const continueBtn = await page.waitForSelector("#log-in-button", { timeout: 12000 });
    await continueBtn.click();
    await sleep(8000);

    try {
      const passInput = await page.waitForSelector('input[name="Passwd"]', { timeout: 20000 });
      await passInput.click();
      await passInput.type(PASSWORD);
      await passInput.press("Enter");
      await sleep(8000);
    } catch (_) {}
  } catch (_) {}

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

// ========= OPTIONAL AUTO CLICKER =========
async function injectAutoClicker(page) {
  await page.evaluate(() => {
    window.autoClickerInterval = setInterval(() => {
      try {
        // Keep empty/minimal — you can add back your old clicker if needed
      } catch (_) {}
    }, 500);
  });
}

// ========= OPEN TOOLS MENU =========
async function openToolsAndClickGenerate(page) {
  // Keep your original logic OR minimal wait — structure can change, so don't hard fail
  try {
    await page.evaluate(() => {
      // try to open tools if available, ignore if not found
      const app = document.querySelector("ucs-standalone-app");
      if (!app || !app.shadowRoot) return false;

      // Attempt to locate any "tools" button by searching inside shadow roots quickly
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

      const toolsBtn = deepFind(app, (n) => {
        const tag = (n.tagName || "").toLowerCase();
        if (tag !== "button" && tag !== "md-icon-button") return false;
        const ar = (n.getAttribute?.("aria-label") || "").toLowerCase();
        const t = (n.getAttribute?.("title") || "").toLowerCase();
        const txt = (n.innerText || "").toLowerCase();
        return ar.includes("tools") || t.includes("tools") || txt.includes("tools");
      });

      if (toolsBtn) {
        const clickTarget = toolsBtn.shadowRoot?.querySelector("button") || toolsBtn;
        clickTarget.click();
        return true;
      }
      return false;
    });

    await sleep(1200);

    // Try click "Generate images (Pro)" menu item if it appears
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

      const targetText = "Generate images (Pro)";
      for (const it of items) {
        const txt = (it.innerText || "").trim();
        if (txt.includes(targetText)) {
          (it.querySelector("li") || it).click();
          return true;
        }
      }
      return false;
    });

    await sleep(1200);
  } catch (_) {
    // ignore
  }
}

// ========= ✅ CORE FIX: ENTER PROMPT + CLICK SUBMIT WITHOUT ASSUMING STRUCTURE =========

// Wait until ProseMirror exists anywhere (deep shadow)
async function waitForProseMirror(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      function deepExists(root) {
        const q = [root];
        const seen = new Set();
        while (q.length) {
          const n = q.shift();
          if (!n || seen.has(n)) continue;
          seen.add(n);

          // direct match
          if (n.nodeType === 1) {
            const el = n;
            if (
              el.matches &&
              el.matches('div.ProseMirror[contenteditable="true"], div.ProseMirror[contenteditable="true"] *')
            ) {
              // if inner, parent might be ProseMirror, ok
              return true;
            }
            if (el.matches && el.matches('div.ProseMirror[contenteditable="true"]')) return true;
          }

          if (n.shadowRoot) n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
          if (n.children) Array.from(n.children).forEach((x) => q.push(x));
        }
        return false;
      }
      return deepExists(document);
    },
    { timeout: timeoutMs }
  );
}

// Focus ProseMirror and place caret
async function focusProseMirrorDeep(page) {
  const res = await page.evaluate(() => {
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

    // find the ProseMirror contenteditable
    const pm = deepFind(document, (n) => {
      if (!n || !n.matches) return false;
      return n.matches('div.ProseMirror[contenteditable="true"]');
    });

    if (!pm) return { ok: false, reason: "no_prosemirror_found" };

    pm.scrollIntoView({ block: "center", behavior: "instant" });
    pm.focus();

    // caret at end
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pm);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}

    return { ok: true };
  });

  if (!res.ok) throw new Error(`Focus editor failed: ${res.reason}`);
}

// Click Submit button inside md-icon-button shadowRoot (deep)
async function clickSubmitDeep(page) {
  const clicked = await page.evaluate(() => {
    function deepFindAll(root, predicate) {
      const q = [root];
      const seen = new Set();
      const out = [];
      while (q.length) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          if (predicate(n)) out.push(n);
        } catch (_) {}
        if (n.shadowRoot) n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
        if (n.children) Array.from(n.children).forEach((x) => q.push(x));
      }
      return out;
    }

    // Find ALL md-icon-button nodes
    const iconButtons = deepFindAll(document, (n) => {
      return n.tagName && n.tagName.toLowerCase() === "md-icon-button";
    });

    // Try exact: md-icon-button.shadowRoot -> button#button[aria-label="Submit"]
    for (const ib of iconButtons) {
      const sr = ib.shadowRoot;
      if (!sr) continue;
      const btn = sr.querySelector('button#button[aria-label="Submit"]');
      if (btn) {
        btn.click();
        return true;
      }
    }

    // Fallback: any button[aria-label=Submit] inside any shadow
    const submitBtns = deepFindAll(document, (n) => {
      if (!n || !n.matches) return false;
      return n.matches('button[aria-label="Submit"]');
    });

    if (submitBtns.length) {
      submitBtns[0].click();
      return true;
    }

    return false;
  });

  return clicked;
}

async function enterPromptAndSend(page, promptText) {
  // Ensure editor exists
  await waitForProseMirror(page, 25000);

  // Focus editor without assuming searchbar/landing
  await focusProseMirrorDeep(page);
  await sleep(150);

  // Clear and type using keyboard (most reliable)
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(50);

  await page.keyboard.type(promptText, { delay: 2 });
  await sleep(200);

  // Click submit
  const ok = await clickSubmitDeep(page);
  if (!ok) {
    console.log("⚠️ Submit not found, fallback ENTER...");
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

        if (start > 0 && start % 10 === 0) {
          console.log(`⚠️ 10 images threshold (${start}). Reset check...`);
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

        console.log("🚀 Submitting prompts...");

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

        const batchTimeout = Date.now() + 600 * 1000;
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
                const fileName = makeRandomFileName(job.sceneNumber);
                const outputFile = path.join(OUTPUT_DIR, fileName);
                await downloadBlobImage(job.page, blobUrl, outputFile);
                job.finished = true;
                continue;
              }

              const banned = await checkBannedError(job.page);
              if (banned) {
                console.log(`❌ Image ${job.sceneNumber}: banned.`);
                job.finished = true;
                continue;
              }

              const elapsed = Date.now() - job.startTime;
              const TIMEOUT_MS = 200000;
              if (elapsed > TIMEOUT_MS) {
                console.log(`⏩ Image ${job.sceneNumber} timeout. Skipping.`);
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
