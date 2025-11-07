import 'dotenv/config';
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  throw new Error('❌ NOTION_DATABASE_ID 가 설정되지 않았습니다.');
}

function normalizeDate(pubdate) {
  if (!pubdate) return null;

  // YYYY-MM-DD 형식 있으면 그대로 사용
  if (/\d{4}-\d{2}-\d{2}/.test(pubdate)) {
    return pubdate;
  }

  // 모르겠으면 지금 시각으로 (나중에 필요하면 개선)
  return new Date().toISOString();
}

export async function upsertPost(post) {
  const {
    title,
    link,
    nickname,
    pubdate,
    description,
    category,
    blogid,
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
    console.log(`↷ 이미 존재: ${title}`);
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
      properties.PubDate = {
        date: { start: normalized },
      };
    }
  }

  if (description) {
    properties.Description = {
      rich_text: [
        {
          text: {
            content: description.slice(0, 1800),
          },
        },
      ],
    };
  }

  if (category) {
    properties.Category = {
      rich_text: [{ text: { content: category } }],
    };
  }

  if (blogid) {
    properties.BlogID = {
      rich_text: [{ text: { content: blogid } }],
    };
  }

  await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
  });

  console.log(`✅ 저장됨: ${title}`);
}
