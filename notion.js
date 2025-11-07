import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  throw new Error('❌ NOTION_DATABASE_ID 가 설정되지 않았습니다.');
}

// pubdate 문자열을 Notion Date 형식으로 정리
function normalizeDate(pubdate) {
  if (!pubdate) return null;

  // 2025.11.01, 2025-11-01 둘 다 처리용 대충 파서
  const clean = pubdate
    .toString()
    .replace(/년|\.|\//g, '-')
    .replace(/월|일/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // YYYY-MM-DD 형식 추출 시도
  const m = clean.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;

  const [_, y, mo, d] = m;
  const mm = mo.padStart(2, '0');
  const dd = d.padStart(2, '0');

  return `${y}-${mm}-${dd}`;
}

export async function upsertPost(post) {
  const {
    title,
    link,
    nickname,
    pubdate,
    description,
    category,
    postId,
  } = post;

  if (!title || !link) return;

  const uniqueId = postId || link;

  // UniqueID 중복 체크
  const existing = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: 'UniqueID',
      rich_text: {
        equals: uniqueId,
      },
    },
  });

  if (existing.results.length > 0) {
    console.log(`↷ 이미 존재 (건너뜀): ${title}`);
    return;
  }

  const properties = {
    Title: {
      title: [{ text: { content: title } }],
    },
    URL: {
      url: link,
    },
    UniqueID: {
      rich_text: [{ text: { content: uniqueId } }],
    },
  };

  if (nickname) {
    properties.Nickname = {
      rich_text: [{ text: { content: nickname } }],
    };
  }

  if (pubdate) {
    const normalized = normalizeDate(pubdate);
    if (normalized) {
      properties['원본 날짜'] = {
        date: { start: normalized },
      };
    }
  }

  if (description) {
    properties.Description = {
      rich_text: [
        {
          text: { content: description.slice(0, 1800) },
        },
      ],
    };
  }

  if (category) {
    properties.Category = {
      rich_text: [{ text: { content: category } }],
    };
  }

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
  });

  console.log(`✅ 저장됨: ${title}`);
}
