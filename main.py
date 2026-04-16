import base64
import json
import time
import requests
import os

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC


# =========================
# 🔥 ENV VARIABLES
# =========================
EMAIL = os.getenv("EMAIL")
PASSWORD = os.getenv("PASSWORD")
GITHUB_TOKEN = os.getenv("GB_TOKEN")
REPO = os.getenv("REPO")
FILE_PATH = "tk.txt"


# =========================
# 🚀 CHROME SETUP (IMPORTANT FOR GITHUB)
# =========================
options = webdriver.ChromeOptions()

options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
options.add_argument("--window-size=1920,1080")

options.add_argument("--disable-blink-features=AutomationControlled")

options.add_experimental_option("excludeSwitches", ["enable-automation"])
options.add_experimental_option("useAutomationExtension", False)

options.set_capability("goog:loggingPrefs", {"performance": "ALL"})


driver = webdriver.Chrome(options=options)
wait = WebDriverWait(driver, 30)


# =========================
# 🌐 OPEN PAGE
# =========================
driver.get(
    "https://studio.speechify.com/sign-in?returnTo=https%3A%2F%2Fstudio.speechify.com%2F"
)

print("Page opened")


# =========================
# 🔐 LOGIN (FIXED WAIT METHOD)
# =========================
try:
    email_input = wait.until(
        EC.presence_of_element_located(
            (By.CSS_SELECTOR, 'input[data-testid="email-input"]')
        )
    )
    email_input.clear()
    email_input.send_keys(EMAIL)

    password_input = wait.until(
        EC.presence_of_element_located(
            (By.CSS_SELECTOR, 'input[data-testid="password-input"]')
        )
    )
    password_input.clear()
    password_input.send_keys(PASSWORD)
    password_input.send_keys(Keys.ENTER)

    print("Login submitted")

except Exception as e:
    print("Login error:", e)
    driver.save_screenshot("login_error.png")
    driver.quit()
    exit()


# =========================
# 🔍 TOKEN FUNCTION
# =========================
def get_token():
    logs = driver.get_log("performance")

    for log in logs:
        try:
            msg = json.loads(log["message"])["message"]

            if msg.get("method") == "Network.requestWillBeSent":
                request = msg["params"]["request"]

                if "videostudio.api.speechify.com/graphql" in request["url"]:
                    headers = request.get("headers", {})
                    token = headers.get("authorization") or headers.get("Authorization")

                    if token:
                        return token
        except:
            pass

    return None


# =========================
# 🔁 WAIT FOR TOKEN
# =========================
token = None

for i in range(25):
    token = get_token()
    if token:
        break
    time.sleep(2)

driver.quit()


# =========================
# ❌ CHECK TOKEN
# =========================
if not token:
    print("Token NOT found")
    exit()

print("TOKEN FOUND")


# =========================
# 🔐 BASE64 ENCODE
# =========================
encoded_token = base64.b64encode(token.encode()).decode()


# =========================
# 📤 UPDATE GITHUB FILE
# =========================
url = f"https://api.github.com/repos/{REPO}/contents/{FILE_PATH}"

headers = {
    "Authorization": f"token {GITHUB_TOKEN}"
}

res = requests.get(url, headers=headers)

if res.status_code != 200:
    print("GitHub file fetch failed:", res.text)
    exit()

sha = res.json()["sha"]

data = {
    "message": "auto update token",
    "content": encoded_token,
    "sha": sha
}

resp = requests.put(url, headers=headers, json=data)

if resp.status_code == 200:
    print("GitHub updated successfully")
else:
    print("GitHub update failed:", resp.text)
