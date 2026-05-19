import os
import requests
import cloudscraper
import json
import time

# GitHub Secrets se variables uthayega
APP_URL = os.environ.get("APP_URL", "https://yourwebsite.com") # e.g., https://elevenchime.com
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")

def fetch_seedream_tokens():
    print("🚀 Starting SeeDream (PDFSimpli) Token Extraction...")
    scraper = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False})
    
    bearer_token = ""
    sas_token = ""
    
    try:
        # 1. Generate Guest Session & Bearer Token
        auth_url = "https://api.worksimpli.io/api/v1/auth/guest"
        headers = {
            "Accept": "application/json",
            "Origin": "https://pdfsimpli.com",
            "Referer": "https://pdfsimpli.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        
        print("Fetching Guest Bearer Token...")
        auth_res = scraper.post(auth_url, headers=headers, json={}, timeout=30)
        
        if auth_res.status_code == 200:
            auth_data = auth_res.json()
            token = auth_data.get("token")
            if token:
                bearer_token = f"Bearer {token}"
                print("✅ Bearer Token Found!")
        
        if not bearer_token:
            print("❌ Failed to get Bearer Token.")
            return

        # 2. Get SAS Token (Using the Bearer Token)
        # Typically PDFSimpli returns SAS token when initiating a document or profile endpoint
        profile_url = "https://api.worksimpli.io/api/v1/user/profile"
        headers["Authorization"] = bearer_token
        
        print("Fetching SAS Token...")
        prof_res = scraper.get(profile_url, headers=headers, timeout=30)
        
        if prof_res.status_code == 200:
            prof_data = prof_res.json()
            sas_token = prof_data.get("sasToken", "")
            if not sas_token:
                # Fallback: Agar direct profile me nahi mila, to general config api check karein
                config_url = "https://api.worksimpli.io/api/v1/config"
                conf_res = scraper.get(config_url, headers=headers)
                sas_token = conf_res.json().get("sasToken", "")

            if sas_token:
                print("✅ SAS Token Found!")
        
        if bearer_token and sas_token:
            send_to_server(bearer_token, sas_token)
        else:
            print("❌ Could not extract both tokens.")
            
    except Exception as e:
        print(f"⚠️ Error occurred during extraction: {e}")

def send_to_server(bearer, sas):
    print(f"🌐 Sending tokens to {APP_URL} ...")
    webhook_url = f"{APP_URL.rstrip('/')}/api/admin/auto-update-seedream"
    
    payload = {
        "bearer_token": bearer,
        "sas_token": sas
    }
    
    headers = {
        "Content-Type": "application/json",
        "X-Cron-Secret": ADMIN_PASSWORD  # Yeh apke app.py ko secure karega
    }
    
    res = requests.post(webhook_url, json=payload, headers=headers)
    if res.status_code == 200:
        print("🎉 Successfully updated tokens on the server!")
    else:
        print(f"❌ Server rejected the update. Status: {res.status_code}, Response: {res.text}")

if __name__ == "__main__":
    fetch_seedream_tokens()
