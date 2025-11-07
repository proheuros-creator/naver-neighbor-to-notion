import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 네이버 pubdate 값을 Notion이 이해할 수 있는 ISO 문자열로 변환
function normalizeNaverDate(raw) {
  if (!raw) return null;

  if (typeof raw === 'number') {
    return new Date(raw).toISOString();
  }

  const s = String(raw).trim();

  // 13자리 밀리초 타임스탬프
  if (/^\d{13}$/.test(s)) {
    return new Date(Number(s)).toISOString();
  }

  // 10자리 초 단위 타임스탬프
  if (/^\d{10}$/.test(s)) {
    return new Date(Number(s) * 1000).toISOString();
  }

  // 대략적인 날짜 포맷 교정
  const replaced = s
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace('년', '-')
    .replace('월', '-')
    .replace('일', '')
    .trim();

  const d = new Date(replaced);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  return null;
}

// ISO 날짜 문자열에서 연/연월/분기 텍스트 추출
function extractYearMonthQuarter(isoString) {
  if (!isoString) {
    return { year: '', yearMonth: '', quarter: '' };
  }

  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    return { year: '', yearMonth: '', quarter: '' };
  }

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1; // 1~12
  const mm = String(month).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  let q;
  if (month <= 3) q = 'Q1';
  else if (month <= 6) q = 'Q2';
  else if (month <= 9) q = 'Q3';
  else q = 'Q4';

  const quarter = `${year}-${q}`; // 예: 2025-Q1

  return { year, yearMonth, quarter };
}

// post: index.js에서 넘어온 { title, link, nickname, pubdate, description, category, postId, blogId }
export async function upsertPost(post) {
  const uniqueId = post.postId ? String(post.postId) : null;
  const blogId = post.blogId ? String(post.blogId) : '';

  // 1️⃣ UniqueID 기준으로 기존 페이지 있는지 조회
  let existing;
  if (uniqueId) {
    const query = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'UniqueID',
        rich_text: {
          equals: uniqueId,
        },
      },
    });

    existing = query.results?.[0];
  }

  // 2️⃣ 날짜 관련 처리
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // 3️⃣ 노션 속성 매핑
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
      rich_text: [{ text: { content: post.nickname || '' } }],
    },
    // 원본 날짜는 date 타입 (있을 때만)
    ...(originalDate
      ? {
          '원본 날짜': {
            date: { start: originalDate },
          },
        }
      : {}),
    '생성 일시': {
      date: { start: createdAt },
    },
    Category: {
      rich_text: [{ text: { content: post.category || '' } }],
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
      rich_text: [{ text: { content: uniqueId || '' } }],
    },
    // blogId → id 컬럼(Text)
    id: {
      rich_text: [{ text: { content: blogId } }],
    },
    // 연도 / 연월 / 분기 → Text 컬럼
    ...(year && {
      연도: {
        rich_text: [{ text: { content: year } }],
      },
    }),
    ...(yearMonth && {
      연월: {
        rich_text: [{ text: { content: yearMonth } }],
      },
    }),
    ...(quarter && {
      분기: {
        rich_text: [{ text: { content: quarter } }],
      },
    }),
  };

  // 4️⃣ upsert: 있으면 update, 없으면 create
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
