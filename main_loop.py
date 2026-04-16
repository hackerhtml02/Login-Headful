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


EMAIL = os.getenv("EMAIL")
PASSWORD = os.getenv("PASSWORD")
GB_TOKEN = os.getenv("GB_TOKEN")
REPO = os.getenv("REPO")
FILE_PATH = "tk.txt"


def run_bot():
    options = webdriver.ChromeOptions()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1920,1080")

    driver = webdriver.Chrome(options=options)
    wait = WebDriverWait(driver, 30)

    driver.get("https://studio.speechify.com/sign-in?returnTo=https%3A%2F%2Fstudio.speechify.com%2F")

    email = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'input[data-testid="email-input"]')))
    email.send_keys(EMAIL)

    password = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, 'input[data-testid="password-input"]')))
    password.send_keys(PASSWORD)
    password.send_keys(Keys.ENTER)

    time.sleep(10)

    token = "demo_token_example"  # yahan apna extraction logic lagao

    driver.quit()

    return token


def update_github(token):
    encoded = base64.b64encode(token.encode()).decode()

    url = f"https://api.github.com/repos/{REPO}/contents/{FILE_PATH}"
    headers = {"Authorization": f"token {GB_TOKEN}"}

    res = requests.get(url, headers=headers)
    sha = res.json()["sha"]

    data = {
        "message": "auto update",
        "content": encoded,
        "sha": sha
    }

    requests.put(url, headers=headers, json=data)


# =========================
# 🔁 INFINITE LOOP (1 HOUR)
# =========================
while True:
    try:
        print("Running bot...")
        token = run_bot()

        print("Updating GitHub...")
        update_github(token)

        print("Done. Sleeping 1 hour...")

    except Exception as e:
        print("Error:", e)

    time.sleep(3600)  # 1 hour sleep
