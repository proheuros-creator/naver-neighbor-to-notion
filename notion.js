/**
 * notion.js
 * ──────────────────────────────────────
 * Naver 이웃새글 포스트를 Notion DB에 upsert 하는 모듈
 *
 * index.js 에서 넘겨주는 post 객체 형태:
 * {
 *   title,
 *   link,
 *   nickname,
 *   pubdate,
 *   description,
 *   category,
 *   blogId,
 *   postId
 * }
 *
 * Notion DB에 필요한 속성:
 *  - Title      : title 타입
 *  - URL        : url 타입
 *  - Nickname   : rich_text
 *  - 원본 날짜    : date
 *  - 생성 일시    : date
 *  - Category   : rich_text
 *  - Description: rich_text
 *  - UniqueID   : rich_text  (blogId_postId)
 *  - ID         : rich_text  (blogId)
 *  - 연도        : rich_text
 *  - 연월        : rich_text
 *  - 분기        : rich_text
 */

import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error('❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.');
  process.exit(1);
}

/**
 * 네이버 pubdate 값을 Notion이 이해할 수 있는 ISO 문자열로 변환
 */
function normalizeNaverDate(raw) {
  if (!raw) return null;

  // 숫자 (타임스탬프)인 경우
  if (typeof raw === 'number') {
    return new Date(raw).toISOString();
  }

  const s = String(raw).trim();

  // 13자리 밀리초 타임스탬프
  if (/^\d{13}$/.test(s)) {
    return new Date(Number(s)).toISOString();
  }

  // 10자리 초 타임스탬프
  if (/^\d{10}$/.test(s)) {
    return new Date(Number(s) * 1000).toISOString();
  }

  // "2025.11.09 08:00", "2025/11/09", "2025년11월9일" 등 대충 포맷 정리
  const replaced = s
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace(/년|\. /g, '-')
    .replace(/월/g, '-')
    .replace(/일/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const d = new Date(replaced);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  return null;
}

/**
 * ISO 날짜 문자열에서 연도 / 연월 / 분기 추출
 */
function extractYearMonthQuarter(isoString) {
  if (!isoString) {
    return { year: '', yearMonth: '', quarter: '' };
  }

  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { year: '', yearMonth: '', quarter: '' };
  }

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  let q;
  if (month <= 3) q = 'Q1';
  else if (month <= 6) q = 'Q2';
  else if (month <= 9) q = 'Q3';
  else q = 'Q4';

  const quarter = `${year}-${q}`;

  return { year, yearMonth, quarter };
}

/**
 * post를 Notion DB에 upsert
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : '';
  const postId = post.postId ? String(post.postId) : '';

  // ✅ UniqueID: blogId_postId 조합 (index.js에서 postId 필터하므로 거의 항상 존재)
  const uniqueId =
    blogId && postId
      ? `${blogId}_${postId}`
      : postId || '';

  if (!uniqueId) {
    console.warn('⚠️ UniqueID 없음, 스킵:', post.title);
    return;
  }

  // 1️⃣ UniqueID 기준 기존 페이지 조회
  let existing = null;
  try {
    const query = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'UniqueID',
        rich_text: {
          equals: uniqueId,
        },
      },
    });
    existing = query.results[0] || null;
  } catch (err) {
    console.error('❌ Notion 조회 오류(UniqueID):', err.message);
  }

  // 2️⃣ 날짜 처리
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // 3️⃣ Notion 속성 매핑
  const properties = {
    Title: {
      title: [
        {
          text: {
            content: post.title || '(제목 없음)',
          },
        },
      ],
    },
    URL: {
      url: post.link || null,
    },
    Nickname: {
      rich_text: [
        {
          text: {
            content: post.nickname || '',
          },
        },
      ],
    },
    ...(originalDate && {
      '원본 날짜': {
        date: { start: originalDate },
      },
    }),
    '생성 일시': {
      date: { start: createdAt },
    },
    Category: {
      rich_text: [
        {
          text: { content: post.category || '' },
        },
      ],
    },
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || '').slice(0, 1800),
          },
        },
      ],
    },
    UniqueID: {
      rich_text: [
        {
          text: { content: uniqueId },
        },
      ],
    },
    // ✅ blogId → ID 컬럼 (대문자)
    ...(blogId && {
      ID: {
        rich_text: [
          {
            text: { content: blogId },
          },
        ],
      },
    }),
    // ✅ 연도 / 연월 / 분기
    ...(year && {
      연도: {
        rich_text: [
          {
            text: { content: year },
          },
        ],
      },
    }),
    ...(yearMonth && {
      연월: {
        rich_text: [
          {
            text: { content: yearMonth },
          },
        ],
      },
    }),
    ...(quarter && {
      분기: {
        rich_text: [
          {
            text: { content: quarter },
          },
        ],
      },
    }),
  };

  // 4️⃣ upsert
  if (existing) {
    await notion.pages.update({
      page_id: existing.id,
      properties,
    });
    console.log(`🔄 업데이트: ${post.title}`);
  } else {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
