import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { upsertPost } from './notion.js';

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const NEIGHBOR_URL = 'https://section.blog.naver.com/neighbor';

if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다. (GitHub Secrets에 NAVER_COOKIE 추가했는지 확인)');
  process.exit(1);
}

async function fetchNeighborHtml() {
  const res = await fetch(NEIGHBOR_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverNeighborScraper)',
      'Cookie': NAVER_COOKIE,
    },
  });

  if (!res.ok) {
    console.error('❌ 이웃새글 페이지 요청 실패:', res.status, res.statusText);
    return null;
  }

  const html = await res.text();
  return html;
}

function extractPostIdFromUrl(url) {
  try {
    const u = new URL(url);

    // 형태 1: /blogId/postId
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      return parts[1];
    }

    // 형태 2: PostView.naver?blogId=xxx&logNo=yyy
    const logNo = u.searchParams.get('logNo');
    if (logNo) return logNo;

    return null;
  } catch (e) {
    return null;
  }
}

function parsePosts(html) {
  const $ = cheerio.load(html);
  const posts = [];

  // ⚠️ 네이버 구조에 따라 class 이름이 다를 수 있음 → 안 나오면 나중에 같이 셀렉터만 손보자
  $('.feed_item, .item, .list_item').each((_, el) => {
    const $el = $(el);

    const title =
      $el.find('.item_title, .title, a.link').first().text().trim() || null;

    let link =
      $el.find('a.item_link, a.link, a').first().attr('href') || '';

    if (link && link.startsWith('/')) {
      link = `https://blog.naver.com${link}`;
    }

    const nickname =
      $el.find('.nickname, .blogger, .user, .name')
        .first()
        .text()
        .trim() || null;

    const pubRaw =
      $el.find('time').attr('datetime') ||
      $el.find('.date, .time').first().text().trim() ||
      null;

    const description =
      $el.find('.desc, .summary, .text, .preview')
        .first()
        .text()
        .trim() || null;

    const category =
      $el.find('.category, .tag').first().text().trim() || null;

    const postId = link ? extractPostIdFromUrl(link) : null;

    if (!title || !link) return;

    posts.push({
      title,
      link,
      nickname,
      pubdate: pubRaw,
      description,
      category,
      postId,
    });
  });

  return posts;
}

async function main() {
  console.log('🚀 네이버 이웃새글 → 노션 동기화 시작');

  const html = await fetchNeighborHtml();
  if (!html) {
    console.error('❌ HTML 로드 실패');
    return;
  }

  const posts = parsePosts(html);
  console.log(`📥 가져온 글 수: ${posts.length}`);

  for (const post of posts) {
    try {
      await upsertPost(post);
    } catch (err) {
      console.error('❌ Notion 저장 중 오류:', err.message);
    }
  }

  console.log('✅ 동기화 완료');
}

main();
