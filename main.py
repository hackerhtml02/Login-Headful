import base64
import json
import time
import requests
import os

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

# =========================
# ENV VARIABLES (GitHub Secrets)
# =========================
EMAIL = os.getenv("EMAIL")
PASSWORD = os.getenv("PASSWORD")
GITHUB_TOKEN = os.getenv("GB_TOKEN")
REPO = os.getenv("REPO")
FILE_PATH = "tk.txt"

# =========================
# CHROME OPTIONS (IMPORTANT)
# =========================
options = webdriver.ChromeOptions()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")
options.add_argument("--disable-blink-features=AutomationControlled")

options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

driver = webdriver.Chrome(options=options)

# =========================
# OPEN LOGIN PAGE
# =========================
driver.get("https://studio.speechify.com/sign-in?returnTo=https%3A%2F%2Fstudio.speechify.com%2F")

time.sleep(5)

# =========================
# LOGIN
# =========================
driver.find_element(By.CSS_SELECTOR, 'input[data-testid="email-input"]').send_keys(EMAIL)

password = driver.find_element(By.CSS_SELECTOR, 'input[data-testid="password-input"]')
password.send_keys(PASSWORD)
password.send_keys(Keys.ENTER)

print("Logging in...")

# =========================
# TOKEN EXTRACT
# =========================
def get_token():
    logs = driver.get_log("performance")

    for log in logs:
        log_json = json.loads(log["message"])["message"]

        if log_json["method"] == "Network.requestWillBeSent":
            request = log_json["params"]["request"]

            if "videostudio.api.speechify.com/graphql" in request["url"]:
                headers = request.get("headers", {})
                token = headers.get("authorization") or headers.get("Authorization")

                if token:
                    return token
    return None

token = None
for i in range(20):
    token = get_token()
    if token:
        break
    time.sleep(2)

driver.quit()

if not token:
    print("Token not found")
    exit()

print("Token found")

# =========================
# BASE64 ENCODE
# =========================
encoded = base64.b64encode(token.encode()).decode()

# =========================
# UPDATE GITHUB FILE
# =========================
url = f"https://api.github.com/repos/{REPO}/contents/{FILE_PATH}"

headers = {
    "Authorization": f"token {GITHUB_TOKEN}"
}

# get SHA
res = requests.get(url, headers=headers)
sha = res.json()["sha"]

data = {
    "message": "auto update token",
    "content": encoded,
    "sha": sha
}

requests.put(url, headers=headers, json=data)

print("GitHub updated")
