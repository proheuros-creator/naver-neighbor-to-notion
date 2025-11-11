/**
 * notion.js
 * ───────────────────────────────────────────────
 * 🧩 네이버 이웃새글 → Notion DB 업서트 모듈
 *
 * ✅ 주요 기능:
 *  - UniqueID(blogId_postId)로 중복 등록 방지
 *  - pubdate 로부터 연도/연월/분기 추출 → 텍스트 컬럼에 저장
 *  - blogId 를 BlogID(Text) 컬럼에 저장
 *  - Group(Text) 컬럼에 이웃그룹 이름 저장 (index.js에서 전달)
 *  - 기존 글이면 update, 없으면 create
 *  - 기존 내용이 동일하면 update 생략 (⏩ 변경 없음)
 *    - 비교 대상: Title, URL, Category, Group
 *    - Description 은 비교 제외 → 사소한 변동/요약 차이로 인한 불필요한 업데이트 방지
 *  - Notion 조회 타임아웃/일시 오류 시 최대 3회 재시도
 *    → 최종 실패 시에도 "누락 방지"를 위해 새 페이지 생성 시도 (중복 가능성 허용)
 *
 * ⚠️ Notion 데이터베이스에 필요한 컬럼 (이름 정확히 일치해야 함):
 *  - Title      : Title
 *  - URL        : URL (URL 타입)
 *  - Nickname   : Text 또는 Rich text
 *  - UniqueID   : Rich text
 *  - BlogID         : Rich text (blogId 저장)
 *  - 연도       : Rich text
 *  - 연월       : Rich text
 *  - 분기       : Rich text
 *  - Group      : Rich text (이웃그룹 이름)
 *  - 원본 날짜  : Date
 *  - 생성 일시  : Date
 *  - Category   : Rich text (옵션)
 *  - Description: Rich text (옵션)
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

/**
 * 네이버 pubdate 필드를 Notion이 이해할 수 있는 ISO 8601 문자열로 변환
 *  - 숫자(타임스탬프), "YYYY.MM.DD", "YYYY-MM-DD HH:mm" 등 유연하게 처리
 */
function normalizeNaverDate(raw) {
  if (!raw) return null;

  // JS number
  if (typeof raw === "number") return new Date(raw).toISOString();

  const s = String(raw).trim();

  // 13자리: milliseconds timestamp
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();

  // 10자리: seconds timestamp
  if (/^\d{10}$/.test(s))
    return new Date(Number(s) * 1000).toISOString();

  // 문자열 날짜 포맷 대충 정규화
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
// 🔁 UniqueID 기반 Notion 페이지 조회 (재시도 포함)
// ───────────────────────────────────────────────

/**
 * UniqueID 값으로 기존 페이지를 조회
 *
 * @param {string} uniqueId
 * @param {number} retries
 * @returns {Promise<object|null|undefined>}
 *   - Page 객체 : 이미 존재
 *   - null      : 정상 조회, 해당 UniqueID 없음
 *   - undefined : 재시도 끝까지 실패 (네트워크/타임아웃 등)
 */
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
        const delay = 1000 * attempt; // 1s → 2s → 3s
        console.log(`⏳ ${delay / 1000}s 후 재시도합니다...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error(
          `❌ Notion 조회 최종 실패: ${uniqueId} (중복 가능성을 감수하고 새로 생성 예정)`
        );
        // undefined → 아래 upsert에서 "새로 생성"으로 처리
        return undefined;
      }
    }
  }
}

// ───────────────────────────────────────────────
// 💾 upsertPost: Notion 페이지 생성/업데이트
// ───────────────────────────────────────────────

/**
 * index.js에서 넘어온 post 객체를 기반으로
 * Notion DB에 페이지를 생성하거나(없으면) 업데이트(있으면) 한다.
 *
 * post 형식:
 *  {
 *    title, link, nickname, pubdate,
 *    description, blogId, postId,
 *    groupName   // index.js에서 전달 (이웃그룹 이름)
 *  }
 */
export async function upsertPost(post) {
  const blogId = post.blogId ? String(post.blogId) : "";
  const postId = post.postId ? String(post.postId) : "";
  const groupName = post.groupName || "";

  // UniqueID = blogId_postId (blogId가 없는 경우 postId만)
  const uniqueId = blogId && postId ? `${blogId}_${postId}` : postId || null;
  if (!uniqueId) {
    console.warn("⚠️ UniqueID 없음, 스킵:", post.title);
    return;
  }

  // 1️⃣ 기존 페이지 조회 (재시도 포함)
  const existing = await findExistingPageWithRetry(uniqueId);
  if (existing === undefined) {
    console.warn(
      `⚠️ [${uniqueId}] 조회 최종 실패 → 누락 방지를 위해 새 페이지 생성 시도 (중복 가능성 있음)`
    );
  }

  // 2️⃣ 날짜 처리
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // 3️⃣ Notion 속성 매핑
  const properties = {
    // 제목
    Title: {
      title: [
        {
          text: { content: post.title || "(제목 없음)" },
        },
      ],
    },

    // 원문 URL
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

    // 원본 게시일
    ...(originalDate && {
      "원본 날짜": {
        date: { start: originalDate },
      },
    }),

    // 스크랩 시각
    "생성 일시": {
      date: { start: createdAt },
    },

    // 카테고리 (있으면)
    Category: {
      rich_text: [
        {
          text: { content: post.category || "" },
        },
      ],
    },

    // 설명/요약 (Notion 길이 제한 고려)
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || "").slice(0, 1800),
          },
        },
      ],
    },

    // UniqueID (텍스트)
    UniqueID: {
      rich_text: [
        {
          text: { content: uniqueId },
        },
      ],
    },

    // blogId → ID 컬럼
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

    // 이웃 그룹명 → Group 컬럼 (Text 타입)
    ...(groupName && {
      Group: {
        rich_text: [
          {
            text: { content: groupName },
          },
        ],
      },
    }),
  };

  // 4️⃣ 업서트 로직
  if (existing) {
    const old = existing.properties;

    // 기존 값 추출 (Description 제외)
    const oldTitle = old.Title?.title?.[0]?.plain_text || "";
    const oldUrl = old.URL?.url || "";
    const oldCat = old.Category?.rich_text?.[0]?.plain_text || "";
    const oldGroup =
      old.Group?.rich_text?.[0]?.plain_text || "";

    const nextTitle = post.title || "(제목 없음)";
    const nextUrl = post.link || null;
    const nextCat = post.category || "";
    const nextGroup = groupName || "";

    const isSame =
      oldTitle === nextTitle &&
      oldUrl === nextUrl &&
      oldCat === nextCat &&
      oldGroup === nextGroup;

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
    // existing === null (정상 미존재) or undefined(조회 실패) → 새 페이지 생성
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
