import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import time

# 환경변수에서 가져오기
NAVER_COOKIE = os.getenv("NAVER_COOKIE")
NOTION_TOKEN = os.getenv("NOTION_TOKEN")
NOTION_DB_ID = os.getenv("NOTION_DB_ID")

BASE_URL = "https://section.blog.naver.com/BlogHome.naver"
USER_AGENT = "Mozilla/5.0"

if not NAVER_COOKIE or not NOTION_TOKEN or not NOTION_DB_ID:
    raise SystemExit("환경변수(NAVER_COOKIE, NOTION_TOKEN, NOTION_DB_ID)가 설정되지 않았습니다.")

def fetch_page(page: int) -> str:
    params = {
        "directoryNo": 0,
        "currentPage": page,
        "groupId": 0
    }
    headers = {
        "User-Agent": USER_AGENT,
        "Cookie": NAVER_COOKIE,
        "Referer": BASE_URL,
    }
    resp = requests.get(BASE_URL, params=params, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.text

def parse_posts(html: str):
    soup = BeautifulSoup(html, "html.parser")
    results = []

    # 단순 방식: 페이지 내 모든 blog.naver.com 링크 수집
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "blog.naver.com" not in href:
            continue

        # 불필요한 파라미터 제거
        url = href.split("?")[0]

        # 제목 텍스트
        title = a.get_text(strip=True)
        if not title:
            continue

        # 대충 블로거 ID 추출
        blogger = ""
        if "blog.naver.com/" in url:
            blogger = url.split("blog.naver.com/")[1].split("/")[0]

        results.append({
            "title": title[:200],
            "url": url,
            "blogger": blogger
        })

    # 중복 제거
    unique = {}
    for item in results:
        unique[item["url"]] = item
    return list(unique.values())

def notion_page_exists(url: str) -> bool:
    """Notion DB에 동일 URL이 이미 있는지 확인"""
    query_url = f"https://api.notion.com/v1/databases/{NOTION_DB_ID}/query"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    payload = {
        "filter": {
            "property": "URL",
            "url": {
                "equals": url
            }
        },
        "page_size": 1
    }
    res = requests.post(query_url, headers=headers, json=payload, timeout=10)
    if res.status_code != 200:
        print("Notion query error:", res.text)
        return False
    data = res.json()
    return len(data.get("results", [])) > 0

def create_notion_page(title: str, blogger: str, url: str):
    create_url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    now = datetime.utcnow().isoformat()

    payload = {
        "parent": {"database_id": NOTION_DB_ID},
        "properties": {
            "Name": {
                "title": [{
                    "text": {"content": title}
                }]
            },
            "Blogger": {
                "rich_text": [{
                    "text": {"content": blogger}
                }]
            },
            "URL": {
                "url": url
            },
            "Scraped At": {
                "date": {"start": now}
            }
        }
    }

    res = requests.post(create_url, headers=headers, json=payload, timeout=10)
    if res.status_code != 200:
        print("Notion insert error:", res.text)
    else:
        print("Saved to Notion:", title, url)

def main():
    max_page = 5  # 이웃 새 글 목록 몇 페이지까지 볼지 (필요하면 조정)
    new_count = 0

    for page in range(1, max_page + 1):
        print(f"[+] Fetch page {page}")
        try:
            html = fetch_page(page)
        except Exception as e:
            print("Page fetch error:", e)
            continue

        posts = parse_posts(html)
        if not posts:
            print("No posts found on this page.")
            continue

        for p in posts:
            url = p["url"]
            if notion_page_exists(url):
                continue
            create_notion_page(p["title"], p["blogger"], url)
            new_count += 1
            time.sleep(0.3)  # 너무 빠르지 않게

        time.sleep(1)

    print(f"Done. New posts saved: {new_count}")

if __name__ == "__main__":
    main()
