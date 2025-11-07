import 'dotenv/config';
import fetch from 'node-fetch';
import { upsertPost } from './notion.js';

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다.');
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error('❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.');
  process.exit(1);
}

// API_TEMPLATE 은 BuddyPostList.naver?page=1&groupId=0 형태여야 함.
// page= 뒷부분만 교체하면서 1~MAX_PAGE 반복 호출.
function buildPageUrl(page) {
  try {
    const url = new URL(API_TEMPLATE);
    url.searchParams.set('page', String(page));
    return url.toString();
  } catch (e) {
    // 만약 URL 생성 실패하면, 정규식으로 대충 치환
    return API_TEMPLATE.replace(/page=\d+/, `page=${page}`);
  }
}

async function fetchPagePosts(page) {
  const url = buildPageUrl(page);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverNeighborScraper)',
      'Cookie': NAVER_COOKIE,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://section.blog.naver.com/BlogHome.naver'
    },
  });

  if (!res.ok) {
    console.error(`❌ ${page}페이지 API 요청 실패:`, res.status, res.statusText);
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    console.error(`❌ ${page}페이지 JSON 파싱 실패:`, e.message);
    return [];
  }

  // BuddyPostList 응답 구조에 맞춰서 리스트 추출
  // (일반적으로 result.buddyPostList 안에 들어있을 가능성이 큼)
  const list =
    data.result?.buddyPostList ||
    data.buddyPostList ||
    data.list ||
    data.items ||
    [];

  return list
    .map((item) => {
      // 🔧 여기 키 이름은 BuddyPostList 응답 구조 기준 (대표적인 패턴)
      const title =
        item.title ||
        item.postTitle ||
        '';

      const blogId =
        item.blogId ||
        item.blogNo ||
        item.bloggerId ||
        '';

      const logNo =
        item.logNo ||
        item.postId ||
        item.articleId ||
        null;

      const link =
        item.url ||
        item.postUrl ||
        (blogId && logNo
          ? `https://blog.naver.com/${blogId}/${logNo}`
          : '');

      const nickname =
        item.nickName ||
        item.bloggerName ||
        item.userName ||
        '';

      const pubdate =
        item.addDate ||
        item.postDate ||
        item.writeDate ||
        item.regDate ||
        item.createdAt ||
        null;

      const description =
        item.briefContents ||
        item.summary ||
        item.contentsPreview ||
        item.previewText ||
        '';

      const category =
        item.categoryName ||
        item.directoryName ||
        item.category ||
        '';

      const postId = logNo || null;

      if (!title || !link) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        category,
        postId,
      };
    })
    .filter(Boolean);
}

async function main() {
  console.log('🚀 BuddyPostList API → Notion 스크랩 시작');
  console.log(`📄 대상 페이지: 1 ~ ${MAX_PAGE}`);

  let total = 0;

  for (let page = 1; page <= MAX_PAGE; page++) {
    const posts = await fetchPagePosts(page);
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
