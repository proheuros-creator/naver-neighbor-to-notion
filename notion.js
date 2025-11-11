/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate 로부터 연도/연월/분기 추출 → 텍스트 컬럼에 저장
 *  - blogId 를 BlogID(Text) 컬럼에 저장
 *  - Group(Multi-select) 컬럼에 CSV 기반 이웃그룹 이름 저장
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *    - 비교 대상: Title, URL, Category, Group
 *    - Description 은 비교 제외
 *  - Notion 조회 타임아웃/일시 오류 시 최대 3회 재시도
 */

import { Client } from "@notionhq/client";

// ───────────────────────────────────────────────
// 🔧 기본 설정
// ───────────────────────────────────────────────

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID 가 설정되어 있지 않습니다.");
  process.exit(1);
}

// ───────────────────────────────────────────────
// 🕒 pubdate → ISO 문자열 변환
// ───────────────────────────────────────────────

function normalizeNaverDate(raw) {
  if (!raw) return null;

  if (typeof raw === "number") return new Date(raw).toISOString();

  const s = String(raw).trim();

  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();

  if (/^\d{10}$/.test(s))
    return new Date(Number(s) * 1000).toISOString();

  const replaced = s
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace("년", "-")
    .replace("월", "-")
    .replace("일", "")
    .trim();

  const d = new Date(replaced);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ───────────────────────────────────────────────
// 📅 ISO 날짜 → 연도/연월/분기
// ───────────────────────────────────────────────

function extractYearMonthQuarter(isoString) {
  if (!isoString) return { year: "", yearMonth: "", quarter: "" };

  const d = new Date(isoString);
  if (isNaN(d.getTime())) return { year: "", yearMonth: "", quarter: "" };

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, "0");
  const yearMonth = `${year}-${mm}`;

  const q = month <= 3 ? "Q1" : month <= 6 ? "Q2" : month <= 9 ? "Q3" : "Q4";
  const quarter = `${year}-${q}`;

  return { year, yearMonth, quarter };
}

// ───────────────────────────────────────────────
// 🔁 UniqueID 기반 Notion 페이지 조회 (재시도)
// ───────────────────────────────────────────────

async function findExistingPageWithRetry(uniqueId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const query = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "UniqueID",
          rich_text: { equals: uniqueId },
        },
      });

      return query.results?.[0] || null;
    } catch (err) {
      const msg = err.code || err.message || String(err);
      console.warn(
        `⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${msg}`
      );

      if (attempt < retries) {
        const delay = 1000 * attempt;
        console.log(`⏳ ${delay / 1000}s 후 재시도합니다...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성 감수 후 새로 생성 예정)`
        );
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
// 🧩 Group 값 → multi_select 형태로 변환
// ───────────────────────────────────────────────

function buildGroupMultiSelect(groupName) {
  if (!groupName) return null;

  const names = String(groupName)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  if (names.length === 0) return null;

  return names.map((name) => ({ name }));
}

function normalizeGroupNamesFromPage(page) {
  const multi =
    page?.properties?.Group?.multi_select || [];
  return multi.map((o) => o.name).filter(Boolean).sort();
}

function normalizeGroupNamesFromInput(groupName) {
  if (!groupName) return [];
  return String(groupName)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .sort();
}

// ───────────────────────────────────────────────
// 💾 upsertPost: Notion 페이지 생성/업데이트
// ───────────────────────────────────────────────

/**
 * post:
 *  {
 *    title,
 *    link,
 *    nickname,
 *    pubdate,
 *    description,
 *    blogId,
 *    postId,
 *    groupName
 *  }
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const groupName = post.groupName || "";

  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;
  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  const existing = await findExistingPageWithRetry(uniqueId);
  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] 조회 최종 실패 → 새 페이지 생성 시도 (중복 가능성 있음)`
    );
  }

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // 기본 properties 구성
  const properties = {
    // 제목
    Title: {
      title: [
        {
          text: { content: post.title || "(제목 없음)" },
        },
      ],
    },

    // URL
    URL: {
      url: post.link || null,
    },

    // 닉네임
    Nickname: {
      rich_text: [
        {
          text: { content: post.nickname || "" },
        },
      ],
    },

    // 원본 날짜
    ...(originalDate && {
      "원본 날짜": {
        date: { start: originalDate },
      },
    }),

    // 스크랩 시각
    "생성 일시": {
      date: { start: createdAt },
    },

    // 카테고리 (옵션)
    Category: {
      rich_text: [
        {
          text: { content: post.category || "" },
        },
      ],
    },

    // 설명/요약
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || "").slice(0, 1800),
          },
        },
      ],
    },

    // UniqueID
    UniqueID: {
      rich_text: [
        {
          text: { content: uniqueId },
        },
      ],
    },

    // blogId → BlogID 컬럼 (텍스트)
    ...(blogId && {
      BlogID: {
        rich_text: [
          {
            text: { content: blogId },
          },
        ],
      },
    }),

    // 연도 / 연월 / 분기
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

  // Group (multi-select)
  const groupMultiSelect = buildGroupMultiSelect(groupName);
  if (groupMultiSelect) {
    properties.Group = {
      multi_select: groupMultiSelect,
    };
  } else {
    // 그룹 정보 없으면 비워두기 (기존 값 유지가 필요하면 여기 로직 조정 가능)
    properties.Group = {
      multi_select: [],
    };
  }

  // 🔍 변경 여부 체크 (기존 페이지가 있는 경우)
  if (existing) {
    const old = existing.properties;

    const oldTitle =
      old.Title?.title?.[0]?.plain_text || "";
    const oldUrl = old.URL?.url || "";
    const oldCat =
      old.Category?.rich_text?.[0]?.plain_text || "";

    const oldGroupNames = normalizeGroupNamesFromPage(existing);
    const nextGroupNames = normalizeGroupNamesFromInput(groupName);

    const nextTitle = post.title || "(제목 없음)";
    const nextUrl = post.link || null;
    const nextCat = post.category || "";

    const isSame =
      oldTitle === nextTitle &&
      oldUrl === nextUrl &&
      oldCat === nextCat &&
      oldGroupNames.join(",") === nextGroupNames.join(",");

    if (isSame) {
      console.log(`⏩ 변경 없음 (스킵): ${post.title}`);
      return;
    }

    await notion.pages.update({
      page_id: existing.id,
      properties,
    });
    console.log(`🔄 업데이트: ${post.title}`);
  } else {
    // 기존 페이지 없음 → 새로 생성
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
