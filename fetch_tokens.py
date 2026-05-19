import os
import json
import time
import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# Environment Variables
APP_URL = os.environ.get("APP_URL", "")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

def send_to_server(bearer, sas):
    if not APP_URL: return
    print(f"🌐 Sending tokens to {APP_URL}...")
    webhook_url = f"{APP_URL.rstrip('/')}/api/admin/auto-update-seedream"
    payload = {"bearer_token": bearer, "sas_token": sas}
    headers = {"Content-Type": "application/json", "X-Cron-Secret": ADMIN_PASSWORD}
    try:
        res = requests.post(webhook_url, json=payload, headers=headers, timeout=30)
        print(f"✅ Server Response: {res.status_code}")
    except Exception as e: print(f"❌ Webhook Error: {e}")

def run_scraper():
    print("🚀 Starting Advanced Stealth Token Extractor...")
    
    chrome_options = Options()
    chrome_options.add_argument("--headless=new")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--window-size=1920,1080")
    chrome_options.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    chrome_options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)

    auth_token = None
    sas_token = None

    try:
        print("🌍 Opening PDFSimpli...")
        driver.get("https://pdfsimpli.com/app/image-editor/generate")

        wait = WebDriverWait(driver, 60)
        time.sleep(10) 

        try:
            prompt_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "textarea, input[type='text'], #empty-generate-prompt")))
            print("✍️ Found Input. Entering prompt...")
            prompt_input.send_keys("cinematic realistic cat walking on moon")
            prompt_input.send_keys(Keys.ENTER)
        except:
            print("⚠️ Prompt element not found. Attempting load-time capture...")

        print("🔍 Scanning Network Traffic for FULL tokens...")
        
        found = False
        for i in range(20):
            logs = driver.get_log('performance')
            for entry in logs:
                log = json.loads(entry['message'])['message']
                if log['method'] == 'Network.requestWillBeSent':
                    url = log['params']['request']['url']
                    headers = log['params']['request']['headers']
                    
                    # 1. Bearer Token Capture
                    if "api/v1" in url and "Authorization" in headers:
                        if not auth_token:
                            auth_token = headers['Authorization']
                            print(f"💎 Found Bearer (Success)")

                    # 2. FULL SAS Token Capture (FIXED)
                    if ".png?" in url and "prodlegalsimplistorage" in url:
                        if not sas_token:
                            # Hum ne .split("&")[0] hata diya hai taake poora URL query milay
                            sas_token = "?" + url.split(".png?")[1] 
                            print(f"💎 Found Full SAS Token!")
                            print(f"DEBUG: {sas_token[:50]}... (Total Length: {len(sas_token)})")

                if auth_token and sas_token:
                    found = True
                    break
            if found: break
            time.sleep(3)

        if auth_token and sas_token:
            send_to_server(auth_token, sas_token)
        else:
            driver.save_screenshot("error_debug.png")
            print("❌ Failed to capture complete tokens.")

    except Exception as e:
        print(f"⚠️ Fatal Error: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    run_scraper()
