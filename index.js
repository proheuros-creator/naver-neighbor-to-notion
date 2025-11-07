import 'dotenv/config';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { upsertPost } from './notion.js';

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다.');
  process.exit(1);
}

// 페이지별 BlogHome URL 생성
function buildPageUrl(page) {
  return `https://section.blog.naver.com/BlogHome.naver?directoryNo=0&currentPage=${page}&groupId=0`;
}

async function fetchPageHtml(page) {
  const url = buildPageUrl(page);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverBlogHomeScraper)',
      'Cookie': NAVER_COOKIE,
    },
  });

  if (!res.ok) {
    console.error(`❌ 페이지 ${page} 요청 실패:`, res.status, res.statusText);
    return null;
  }

  return await res.text();
}

// BlogHome 페이지 HTML → 게시글 리스트 파싱
function parsePostsFromPage(html) {
  const $ = cheerio.load(html);
  const posts = [];

  // 네이버 BlogHome의 카드/리스트 구조를 넓게 잡아서 탐색
  // (실제 구조에 따라 조정 가능)
  $('li, .item, .list_post, .list_item').each((_, el) => {
    const $el = $(el);

    // 블로그 글 링크: blog.naver.com 포함된 첫 번째 a 태그
    let link = $el.find('a[href*="blog.naver.com"]').first().attr('href');
    if (!link) return;

    // 상대경로면 절대 URL로
    if (link.startsWith('/')) {
      link = `https://blog.naver.com${link}`;
    }

    // 제목: 링크 안 텍스트 또는 주변 텍스트
    const title =
      ($el.find('a[href*="blog.naver.com"]').first().text() ||
        $el.find('.title, .tit').first().text() ||
        '').trim();

    if (!title) return;

    // 닉네임/블로그명
    const nickname =
      ($el.find('.nick, .nickname, .blogger, .user').first().text() ||
        '').trim() || null;

    // 날짜
    const pubdate =
      ($el.find('.date, .time').first().text() || '').trim() || null;

    // 요약
    const description =
      ($el.find('.desc, .dsc, .summary, .post_text, .txt').first().text() ||
        '').trim() || null;

    // 카테고리
    const category =
      ($el.find('.category, .cate').first().text() || '').trim() || null;

    // UniqueID용 postId 추출 (URL에서 logNo나 숫자 부분)
    let postId = null;
    try {
      const u = new URL(link);
      const logNo = u.searchParams.get('logNo');
      if (logNo) {
        postId = logNo;
      } else {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
          postId = parts[1];
        }
      }
    } catch (e) {
      // URL 파싱 실패시 무시
    }

    posts.push({
      title,
      link,
      nickname,
      pubdate,
      description,
      category,
      postId,
    });
  });

  return posts;
}

async function main() {
  console.log('🚀 Naver BlogHome → Notion 스크랩 시작');
  console.log(`📄 대상 페이지: 1 ~ ${MAX_PAGE}`);

  let total = 0;

  for (let page = 1; page <= MAX_PAGE; page++) {
    const html = await fetchPageHtml(page);
    if (!html) continue;

    const posts = parsePostsFromPage(html);
    console.log(`📥 ${page}페이지에서 가져온 글 수: ${posts.length}`);
    total += posts.length;

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error('❌ Notion 저장 오류:', err.message);
      }
    }
  }

  console.log(`✅ 전체 스크랩 완료. 총 ${total}건 처리 시도.`);
}

main();
