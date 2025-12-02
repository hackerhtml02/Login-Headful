// login_headful.js
// Headful (local) / headless-ish (CI) login script, with fresh profile.
// Local: interactive, CI: non-interactive.

const puppeteer = require("puppeteer");
const fs = require("fs");
const readline = require("readline");

// ======= CONFIG =======
// Email / password priority: ENV vars, warna hardcoded fallback (local testing)
const EMAIL = process.env.GEMINI_EMAIL || "admin@veocraftai.live";
const PASSWORD =
  process.env.GEMINI_PASSWORD || "HafsaHaris11$$"; // local mein change karo

const GEMINI_URL = "https://business.gemini.google/";
const PROFILE_DIR = "C:\\selenium_gemini_profile";
const BROWSER_PATH =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// CI mode? (GitHub Actions automatically CI=true set karta hai)
const IS_CI = process.env.CI === "true";

// ---------- sleep helper ----------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- askQuestion (local only) ----------
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

// ---------- delete profile folder ----------
function deleteProfileFolder() {
  if (fs.existsSync(PROFILE_DIR)) {
    console.log(`Deleting existing profile folder: ${PROFILE_DIR}`);
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log("Creating fresh profile folder...");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

// ---------- element presence ----------
async function isElementPresent(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- Welcome dialog: "I'll do this later" ----------
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
          if (innerBtn) {
            label = innerBtn.innerText.trim();
          }
        }

        if (!label) {
          label = mdBtn.innerText.trim();
        }

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
    console.log("Clicked 'I'll do this later' dialog button:", laterClicked);
    await sleep(4000);
  } catch (e) {
    console.log("Welcome dialog dismiss error (ignored):", e.message);
  }
}

// ---------- Login function ----------
async function ensureLoggedIn(page) {
  await page.goto(GEMINI_URL, { waitUntil: "networkidle2" });
  await sleep(3000);

  if (await isElementPresent(page, "#email-input", 8000)) {
    console.log("Login required: entering email...");

    const emailInput = await page.waitForSelector("#email-input");
    await emailInput.click();
    await page.evaluate((el) => (el.value = ""), emailInput);
    await emailInput.type(EMAIL);
    console.log("Email entered!");

    const continueBtn = await page.waitForSelector("#log-in-button");
    await continueBtn.click();
    console.log("Continue clicked");

    try {
      const idInput = await page.waitForSelector("#identifierId", {
        timeout: 15000,
      });
      await idInput.press("Enter");
      console.log("Identifier Next pressed");
    } catch {
      console.log("identifierId not found, skipping");
    }

    await sleep(4000);

    try {
      const passInput = await page.waitForSelector('input[name="Passwd"]', {
        timeout: 20000,
      });
      await passInput.click();
      await passInput.type(PASSWORD);
      console.log("Password entered!");
      await passInput.press("Enter");
    } catch {
      console.log("Password field not found, maybe manual login needed!");
    }

    console.log(
      "\n⚠️ If extra verification appears (2FA, phone, captcha), complete it manually (local run)."
    );
    await sleep(20000);
  } else {
    console.log("Already logged in / email field not visible.");
    await sleep(5000);
  }
}

// ---------- MAIN ----------
async function main() {
  // 1. Delete old profile + recreate
  deleteProfileFolder();

  console.log(
    `\nLaunching browser for fresh login... (CI mode: ${IS_CI ? "YES" : "NO"})\n`
  );

  const browser = await puppeteer.launch({
    headless: IS_CI, // local: UI visible, CI: headless
    executablePath: BROWSER_PATH,
    userDataDir: PROFILE_DIR,
    // CI pe agar Edge/Chrome nahi mila to yahan adjust karna padega
  });

  const page = await browser.newPage();

  try {
    await ensureLoggedIn(page);
    await dismissWelcomeIfPresent(page);

    if (!IS_CI) {
      console.log(
        "\n🎉 If you see the Gemini dashboard and no welcome popup, login is complete!"
      );
      console.log("Your fresh profile has been saved.");
      await askQuestion("\nPress Enter to close browser...");
    } else {
      console.log(
        "\nCI mode: Login flow attempted, closing browser automatically in a few seconds..."
      );
      await sleep(10000);
    }
  } catch (err) {
    console.log("Error during login:", err);
    if (!IS_CI) {
      await askQuestion("Press Enter to close browser after error...");
    }
  }

  await browser.close();
}

main().catch((err) => console.error("Fatal:", err));
