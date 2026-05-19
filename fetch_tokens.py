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
    if not APP_URL:
        print("❌ Error: APP_URL is not set.")
        return
    print(f"🌐 Sending tokens to {APP_URL}...")
    webhook_url = f"{APP_URL.rstrip('/')}/api/admin/auto-update-seedream"
    payload = {"bearer_token": bearer, "sas_token": sas}
    headers = {"Content-Type": "application/json", "X-Cron-Secret": ADMIN_PASSWORD}
    
    try:
        res = requests.post(webhook_url, json=payload, headers=headers, timeout=30)
        if res.status_code == 200:
            print("🎉 Successfully updated tokens on the server!")
        else:
            print(f"❌ Server rejected update: {res.status_code}")
    except Exception as e:
        print(f"❌ Failed to send update: {e}")

def run_scraper():
    print("🚀 Starting Selenium Token Extractor...")
    
    chrome_options = Options()
    chrome_options.add_argument("--headless")  # GitHub Actions ke liye zaroori
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)

    auth_token = None
    sas_token = None

    try:
        print("🌍 Opening PDFSimpli...")
        driver.get("https://pdfsimpli.com/app/image-editor/generate")

        wait = WebDriverWait(driver, 40)
        # Element ka wait
        prompt_input = wait.until(EC.presence_of_element_located((By.ID, "empty-generate-prompt")))

        print("✍️ Entering prompt to trigger API...")
        prompt_input.send_keys("a beautiful cinematic landscape")
        prompt_input.send_keys(Keys.ENTER)

        print("🔍 Monitoring Network Logs...")
        
        found = False
        # 60 seconds tak loop chalayenge jab tak dono cheezein na mil jayein
        for i in range(30):
            logs = driver.get_log('performance')
            for entry in logs:
                log = json.loads(entry['message'])['message']
                
                if log['method'] == 'Network.requestWillBeSent':
                    url = log['params']['request']['url']
                    headers = log['params']['request']['headers']
                    
                    # 1. Authorization Header Dhoondna
                    if "api/v1/imagegeneration" in url and "Authorization" in headers:
                        if not auth_token:
                            auth_token = headers['Authorization']
                            print(f"✅ Found Bearer Token: {auth_token[:30]}...")

                    # 2. SAS Token Dhoondna
                    if ".png?" in url and "prodlegalsimplistorage" in url:
                        if not sas_token:
                            sas_token = "?" + url.split(".png?")[1]
                            # Clean SAS token (if there are extra chars)
                            if "&" in sas_token:
                                sas_token = sas_token.split("&")[0] # Sirf zaroori hissa lein
                            print(f"✅ Found SAS Token: {sas_token[:30]}...")

                if auth_token and sas_token:
                    found = True
                    break
            
            if found: break
            time.sleep(3)

        if auth_token and sas_token:
            send_to_server(auth_token, sas_token)
        else:
            print("❌ Failed to capture tokens. Timing out.")

    except Exception as e:
        print(f"⚠️ Error: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    run_scraper()
