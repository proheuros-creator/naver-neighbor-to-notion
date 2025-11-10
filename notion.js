/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈 (ESM)
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate로부터 연도/연월/분기 추출
 *  - blogId를 ID 컬럼에 저장
 *  - Group(이웃그룹) 컬럼 지원
 *  - 기존 글이면 update, 없으면 create
 *  - 주요 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *  - Notion 조회 타임아웃 시 최대 3회 재시도
 *  - 조회 최종 실패 시에도 새 페이지 생성 시도 (중복 허용, 누락 방지 우선)
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
// 🕒 pubdate ISO 변환
// ───────────────────────────────────────────────
function normalizeNaverDate(raw) {
  if (!raw) return null;

  if (typeof raw === "number") {
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

  // 문자열 포맷 대충 정규화
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
// 📅 연도·연월·분기 추출
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
/**
 * 🔁 UniqueID로 기존 페이지 조회 (최대 3회 재시도)
 *
 * 반환:
 *  - Page 객체  : 기존 페이지 1건 발견
 *  - null       : 정상 조회, 해당 UniqueID 없음
 *  - undefined  : 3회 전부 실패 → 이후 로직에서 "새로 생성"으로 처리 (중복 가능성 허용)
 */
// ───────────────────────────────────────────────
async function findExistingPageWithRetry(uniqueId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const query = await notion.databases.query({
        database_id: databaseId,
        filter: {
          property: "UniqueID",
          rich_text: {
            equals: uniqueId,
          },
        },
      });

      return query.results?.[0] || null;
    } catch (err) {
      const code = err.code || "";
      const msg = err.message || String(err);

      console.warn(
        `⚠️ Notion 조회 실패 (${attempt}/${retries}) [${uniqueId}]: ${code} ${msg}`
      );

      if (attempt < retries) {
        const delay = 1000 * attempt; // 1s → 2s → 3s
        console.log(`⏳ ${delay / 1000}s 후 재시도합니다...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성 감수, 새 페이지 생성 시도)`
        );
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
/**
 * 💾 upsertPost(post)
 *  - 기존 글: 주요 필드 변경 시에만 update
 *  - 신규 글 or 조회 실패: create
 */
// ───────────────────────────────────────────────
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";

  // UniqueID = blogId_postId or postId 단독
  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;
  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  // 1️⃣ 기존 페이지 조회 (재시도 포함)
  const existing = await findExistingPageWithRetry(uniqueId);
  // existing:
  //  - Page 객체 : 이미 있음
  //  - null      : 없음 (정상)
  //  - undefined : 조회 실패 → 아래에서 새로 생성 시도

  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] 조회 실패로 상태 확인 불가 → 누락 방지를 위해 새 페이지 생성 시도 (중복 가능성 있음)`
    );
  }

  // 2️⃣ 날짜/연도/연월/분기 계산
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // 3️⃣ 공통 properties 구성
  const properties = {
    Title: {
      title: [
        {
          text: {
            content: post.title || "(제목 없음)",
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
          text: { content: post.nickname || "" },
        },
      ],
    },
    ...(originalDate && {
      "원본 날짜": {
        date: { start: originalDate },
      },
    }),
    "생성 일시": {
      date: { start: createdAt },
    },
    Category: {
      rich_text: [
        {
          text: { content: post.category || "" },
        },
      ],
    },
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || "").slice(0, 1800),
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
    ...(blogId && {
      ID: {
        rich_text: [
          {
            text: { content: blogId },
          },
        ],
      },
    }),
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
    ...(post.group && {
      Group: {
        rich_text: [
          {
            text: { content: post.group },
          },
        ],
      },
    }),
  };

  // 4️⃣ 업서트 로직
  if (existing) {
    const old = existing.properties;

    const oldTitle = old.Title?.title?.[0]?.plain_text || "";
    const oldUrl = old.URL?.url || "";
    const oldCat = old.Category?.rich_text?.[0]?.plain_text || "";
    const oldGroup = old.Group?.rich_text?.[0]?.plain_text || "";

    const isSame =
      oldTitle === (post.title || "") &&
      oldUrl === (post.link || null) &&
      oldCat === (post.category || "") &&
      // Group은 "기존에 값이 있는데 동일한지"만 비교
      oldGroup === (post.group || oldGroup || "");

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
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
