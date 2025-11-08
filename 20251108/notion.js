import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 네이버 pubdate 값을 Notion이 이해할 수 있는 문자열로 변환
function normalizeNaverDate(raw) {
  if (!raw) return null;

  // 숫자거나 숫자 문자열인 경우 (타임스탬프 가정)
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

  // 이미 날짜 포맷인 경우들 (대충 맞으면 그대로 또는 ISO로)
  // 예: "2025-11-07", "2025.11.07 12:34", "2025-11-07 12:34:56"
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

  // 도저히 해석 안 되면 null 처리
  return null;
}

export async function upsertPost(post) {
  const uniqueId = post.postId ? String(post.postId) : null;

  // 1️⃣ UniqueID(=postId) 기준 중복 여부 확인
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

  // 2️⃣ 날짜 변환
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();

  // 3️⃣ 노션 속성 매핑 (DB 컬럼명에 맞춤)
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
    // 원본 날짜: 유효한 값일 때만 설정
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
  };

  // 4️⃣ 존재하면 업데이트, 없으면 새로 생성
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
