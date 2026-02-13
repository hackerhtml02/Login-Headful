// generate_image.js
//
// ✅ PHASE 1: All tabs -> prompt PASTE (NO typing, NO innerHTML, TrustedTypes safe)
// ✅ PHASE 2: All tabs -> SUBMIT click (mouse coordinate click; works even with closed shadow)
// ✅ Still keeps your login/reset logic
//
// Run:
// node generate_image.js --promptFile=prompts.txt --maxTabs=5 --headless=false
//
// Env (recommended):
// set GEMINI_EMAIL=...
// set GEMINI_PASSWORD=...

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

const OUTPUT_DIR =
  argMap.outputDir || process.env.OUTPUT_DIR || path.join(process.cwd(), "output_images");
const JOB_META_PATH = argMap.jobMeta || process.env.JOB_META_PATH || null;
const USER_DATA_DIR =
  argMap.userDataDir || process.env.USER_DATA_DIR || path.join(process.cwd(), "gemini_profile");

let maxTabs = parseInt(argMap.maxTabs || process.env.MAX_TABS || "1", 5);
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
    const laterClicked = await page.evaluate(() => {
      const app = document.querySelector("ucs-standalone-app");
      if (!app?.shadowRoot) return false;
      const welcome = app.shadowRoot.querySelector("ucs-welcome-dialog");
      if (!welcome?.shadowRoot) return false;
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
    if (laterClicked) await sleep(2500);
  } catch (_) {}
}

async function clickAgreeButton(page) {
  try {
    if (await isElementPresent(page, ".agree-button", 4000)) {
      await page.click(".agree-button");
      await sleep(3500);
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
      await sleep(3500);
      await dismissWelcomeIfPresent(page);
      return true;
    }
  } catch (_) {}
  return false;
}

// ========= ACCOUNT RESET =========
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

  await sleep(2500);
  if (await clickAgreeButton(page)) return;

  const dashboard = await page.evaluate(() => !!document.querySelector("ucs-standalone-app"));
  if (dashboard) {
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
        await sleep(3500);
      } else {
        if (i === 1) break;
      }
    } catch (_) {}
  }

  await clickAgreeButton(page);
  await dismissWelcomeIfPresent(page);
  console.log("✅ Ready.");
}

// ========= DEEP SHADOW UTIL =========
function deepWalkAllNodes() {
  // Runs in browser context (page.evaluate)
  const q = [document];
  const seen = new Set();
  const out = [];
  while (q.length) {
    const n = q.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (n.shadowRoot) {
      q.push(n.shadowRoot);
      n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
    }
    if (n.children) Array.from(n.children).forEach((x) => q.push(x));
    if (n.childNodes) Array.from(n.childNodes).forEach((x) => q.push(x));
  }
  return out;
}

async function waitForProseMirrorDeep(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => {
      const nodes = (() => {
        const q = [document];
        const seen = new Set();
        while (q.length) {
          const n = q.shift();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          if (n.nodeType === 1 && n.matches && n.matches('div.ProseMirror[contenteditable="true"]')) return true;
          if (n.shadowRoot) {
            q.push(n.shadowRoot);
            n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
          }
          if (n.children) Array.from(n.children).forEach((x) => q.push(x));
        }
        return false;
      })();
      return nodes === true;
    },
    { timeout: timeoutMs }
  );
}

// ========= ✅ TRUSTED-TYPES SAFE PASTE (NO innerHTML) =========
async function pastePromptTrustedSafe(page, promptText) {
  const res = await page.evaluate((text) => {
    function deepFind(predicate) {
      const q = [document];
      const seen = new Set();
      while (q.length) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          if (predicate(n)) return n;
        } catch (_) {}
        if (n.shadowRoot) {
          q.push(n.shadowRoot);
          n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
        }
        if (n.children) Array.from(n.children).forEach((x) => q.push(x));
      }
      return null;
    }

    const pm = deepFind((n) => n?.matches?.('div.ProseMirror[contenteditable="true"]'));
    if (!pm) return { ok: false, reason: "no_prosemirror" };

    pm.scrollIntoView({ block: "center", behavior: "instant" });
    pm.focus();

    // select all
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(pm);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}

    // Try beforeinput (ProseMirror likes this)
    let inserted = false;
    try {
      const evt = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      });
      const ok = pm.dispatchEvent(evt);
      // If not prevented, we can execCommand
      inserted = ok === true;
    } catch (_) {}

    // execCommand insertText (best for contenteditable; does NOT use innerHTML)
    try {
      // clear selection content then insert
      document.execCommand("insertText", false, text);
      inserted = true;
    } catch (_) {}

    // Force input event so app sees change
    try {
      pm.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } catch (_) {
      try {
        const e = document.createEvent("HTMLEvents");
        e.initEvent("input", true, true);
        pm.dispatchEvent(e);
      } catch (_) {}
    }

    return { ok: inserted === true };
  }, promptText);

  if (!res?.ok) throw new Error(`Paste failed: ${res?.reason || "unknown"}`);
}

// ========= ✅ FIND SUBMIT CLICK POINT (works even if button inside closed shadow) =========
async function getSubmitClickPoint(page) {
  return page.evaluate(() => {
    function deepFindAll(predicate) {
      const q = [document];
      const seen = new Set();
      const found = [];
      while (q.length) {
        const n = q.shift();
        if (!n || seen.has(n)) continue;
        seen.add(n);
        try {
          if (predicate(n)) found.push(n);
        } catch (_) {}
        if (n.shadowRoot) {
          q.push(n.shadowRoot);
          n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
        }
        if (n.children) Array.from(n.children).forEach((x) => q.push(x));
      }
      return found;
    }

    // Prefer explicit button aria-label
    const btns = deepFindAll((n) => n?.matches?.('button[aria-label]'));
    const wanted = btns.filter((b) => {
      const ar = (b.getAttribute("aria-label") || "").toLowerCase();
      return ar.includes("submit") || ar.includes("send") || ar.includes("generate") || ar.includes("search");
    });

    function centerOf(el) {
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return null;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // must be on-screen
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
      return { x, y };
    }

    // 1) direct wanted button
    for (let i = wanted.length - 1; i >= 0; i--) {
      const c = centerOf(wanted[i]);
      if (c) return { ...c, why: "aria_button" };
    }

    // 2) md-icon-button hosts (often clickable even if inner closed shadow)
    const icons = deepFindAll((n) => (n?.tagName || "").toLowerCase() === "md-icon-button");
    // try to pick last visible
    for (let i = icons.length - 1; i >= 0; i--) {
      const c = centerOf(icons[i]);
      if (c) return { ...c, why: "md_icon_button_host" };
    }

    // 3) any element with role=button + aria-label keywords
    const roleBtns = deepFindAll((n) => {
      if (!n?.getAttribute) return false;
      const role = (n.getAttribute("role") || "").toLowerCase();
      if (role !== "button") return false;
      const ar = (n.getAttribute("aria-label") || "").toLowerCase();
      const txt = (n.innerText || "").toLowerCase();
      return (
        ar.includes("submit") ||
        ar.includes("send") ||
        ar.includes("generate") ||
        txt.includes("submit") ||
        txt.includes("send") ||
        txt.includes("generate")
      );
    });
    for (let i = roleBtns.length - 1; i >= 0; i--) {
      const c = centerOf(roleBtns[i]);
      if (c) return { ...c, why: "role_button" };
    }

    return null;
  });
}

async function clickSubmitByMouse(page) {
  const pt = await getSubmitClickPoint(page);
  if (!pt) return { ok: false, method: "no_click_point" };

  // IMPORTANT: Some UIs need small jitter / double click
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(120);
  await page.mouse.click(pt.x, pt.y);
  return { ok: true, method: pt.why };
}

// ========= TOOL MENU (optional - tolerant) =========
async function openToolsAndClickGenerate(page) {
  // If already in image mode, this can fail safely.
  try {
    await page.evaluate(() => {
      const q = [document];
      const seen = new Set();
      function deepFind(predicate) {
        while (q.length) {
          const n = q.shift();
          if (!n || seen.has(n)) continue;
          seen.add(n);
          try {
            if (predicate(n)) return n;
          } catch (_) {}
          if (n.shadowRoot) {
            q.push(n.shadowRoot);
            n.shadowRoot.querySelectorAll("*").forEach((x) => q.push(x));
          }
          if (n.children) Array.from(n.children).forEach((x) => q.push(x));
        }
        return null;
      }

      const toolsBtn = deepFind((n) => {
        if (!n?.getAttribute) return false;
        const ar = (n.getAttribute("aria-label") || "").toLowerCase();
        const t = (n.getAttribute("title") || "").toLowerCase();
        const txt = (n.innerText || "").toLowerCase();
        return ar.includes("tools") || t.includes("tools") || txt.includes("tools");
      });

      if (!toolsBtn) return false;
      (toolsBtn.shadowRoot?.querySelector("button") || toolsBtn).click();
      return true;
    });

    await sleep(1100);

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

    await sleep(900);
  } catch (_) {}
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

// ========= DOWNLOAD =========
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

        if (start > 0 && start % 5 === 0) {
          console.log(`⚠️ 5 images threshold (${start}). Reset check...`);
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

        await sleep(3500);

        const batchJobs = pages.map((page, idx) => ({
          page,
          prompt: batchPrompts[idx],
          sceneNumber: globalIndex + 1 + idx,
          finished: false,
          startTime: null,
        }));
        globalIndex += batchPrompts.length;

        // ===========================
        // ✅ PHASE 0 (optional): tool mode attempt
        // ===========================
        await Promise.all(
          batchJobs.map(async (job) => {
            try {
              await openToolsAndClickGenerate(job.page);
            } catch (_) {}
          })
        );

        // ===========================
        // ✅ PHASE 1: PASTE ALL TABS (AT A TIME)
        // ===========================
        console.log("\n🚀 PHASE 1: Pasting prompts on ALL tabs...");
        await Promise.all(
          batchJobs.map(async (job) => {
            console.log(` [Image ${job.sceneNumber}] Paste...`);
            try {
              await waitForProseMirrorDeep(job.page, 30000);
              await pastePromptTrustedSafe(job.page, job.prompt);
              console.log(` ✅ [Image ${job.sceneNumber}] Pasted`);
            } catch (e) {
              console.error(` ❌ [Image ${job.sceneNumber}] Paste Failed:`, e.message);
            }
          })
        );

        // Small settle time so UI enables submit
        await sleep(600);

        // ===========================
        // ✅ PHASE 2: SUBMIT ALL TABS (AT A TIME)
        // ===========================
        console.log("\n🚀 PHASE 2: Submitting on ALL tabs...");
        await Promise.all(
          batchJobs.map(async (job) => {
            console.log(` [Image ${job.sceneNumber}] Submit...`);
            try {
              const r = await clickSubmitByMouse(job.page);
              if (!r.ok) throw new Error(r.method);
              job.startTime = Date.now();
              console.log(` ✅ [Image ${job.sceneNumber}] Submitted (${r.method})`);
            } catch (e) {
              console.error(` ❌ [Image ${job.sceneNumber}] Submit Failed:`, e.message);
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
