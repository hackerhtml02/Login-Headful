import time
import base64
import requests
import json
import os

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


# =========================
# ENV VARIABLES
# =========================
EMAIL = os.getenv("EMAIL")
PASSWORD = os.getenv("PASSWORD")
GITHUB_TOKEN = os.getenv("GB_TOKEN")
REPO = os.getenv("REPO")
FILE_PATH = "tk.txt"


# =========================
# BROWSER SETUP (CDP ENABLED)
# =========================
def start_driver():
    options = webdriver.ChromeOptions()

    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1920,1080")

    # 🔥 REQUIRED FOR PERFORMANCE LOGS
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

    driver = webdriver.Chrome(options=options)

    # 🔥 ENABLE NETWORK TRACKING (VERY IMPORTANT)
    driver.execute_cdp_cmd("Network.enable", {})

    return driver


# =========================
# LOGIN FUNCTION
# =========================
def login(driver):
    wait = WebDriverWait(driver, 30)

    driver.get("https://studio.speechify.com/sign-in?returnTo=https%3A%2F%2Fstudio.speechify.com%2F")

    print("Page opened")

    email = wait.until(
        EC.presence_of_element_located((By.CSS_SELECTOR, 'input[data-testid="email-input"]'))
    )
    email.send_keys(EMAIL)

    password = wait.until(
        EC.presence_of_element_located((By.CSS_SELECTOR, 'input[data-testid="password-input"]'))
    )
    password.send_keys(PASSWORD)
    password.send_keys(Keys.ENTER)

    print("Login submitted")

    time.sleep(10)


# =========================
# TOKEN EXTRACTION (CDP LOGS)
# =========================
def get_token(driver):
    logs = driver.get_log("performance")

    for entry in logs:
        try:
            msg = json.loads(entry["message"])["message"]

            if msg.get("method") == "Network.requestWillBeSent":
                request = msg["params"]["request"]

                url = request.get("url", "")

                # 🔥 IMPORTANT: partial match
                if "videostudio.api.speechify.com/graphql" in url:
                    headers = request.get("headers", {})

                    token = headers.get("authorization") or headers.get("Authorization")

                    if token:
                        return token

        except:
            pass

    return None


# =========================
# GITHUB UPDATE
# =========================
def update_github(token):
    encoded = base64.b64encode(token.encode()).decode()

    url = f"https://api.github.com/repos/{REPO}/contents/{FILE_PATH}"

    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json"
    }

    res = requests.get(url, headers=headers)

    if res.status_code != 200:
        print("GitHub GET failed:", res.text)
        return

    sha = res.json()["sha"]

    data = {
        "message": "auto update token",
        "content": encoded,
        "sha": sha
    }

    r = requests.put(url, headers=headers, json=data)

    if r.status_code == 200:
        print("✅ GitHub updated")
    else:
        print("❌ GitHub update failed:", r.text)


# =========================
# MAIN BOT LOOP (1 HOUR)
# =========================
while True:
    driver = None

    try:
        print("\n========================")
        print("Starting bot...")

        driver = start_driver()

        login(driver)

        print("Searching token...")

        token = None

        for i in range(30):
            token = get_token(driver)

            if token:
                break

            time.sleep(2)

        driver.quit()

        if not token:
            print("❌ Token not found")
        else:
            print("✅ TOKEN FOUND:", token)

            update_github(token)

    except Exception as e:
        print("Error:", e)

        try:
            driver.quit()
        except:
            pass

    print("Sleeping 1 hour...\n")
    time.sleep(3600)
