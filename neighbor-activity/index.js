// neighbor-activity/index.js

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const { baseId, maxPages, delayMs } = require("./config");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FOLLOWINGS_BASE =
  "https://section.blog.naver.com/connect/ViewMoreFollowings.naver";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * groups.js (ESM) 로드
 * - export const GROUPS = [ { id, name }, ... ]
 * - neighbor-activity 기준 상위 폴더(../groups.js)에 있다고 가정
 */
async function loadGroups() {
  try {
    const mod = await import("../groups.js");
    const arr = Array.isArray(mod.GROUPS) ? mod.GROUPS : [];
    const map = {};
    for (const g of arr) {
      if (!g || g.id == null) continue;
      map[String(g.id)] = g.name || "";
    }
    return { groupList: arr, groupMap: map };
  } catch (e) {
    console.log("⚠️ groups.js 로드 실패 (그룹 정보 없이 진행):", e.message);
    return { groupList: [], groupMap: {} };
  }
}

/**
 * href에서 blogId 추출: https://blog.naver.com/{id}
 */
function extractBlogId(href) {
  if (!href) return null;
  const m = href.match(/^https?:\/\/blog\.naver\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * ViewMoreFollowings HTML에서 이웃 추가
 * - groupIdOrNull 있으면 해당 그룹 소속으로도 기록
 */
function collectFromFollowingsHtml(html, neighborsMap, groupIdOrNull) {
  const $ = cheerio.load(html);

  $("a[href*='blog.naver.com/']").each((_, el) => {
    const href = $(el).attr("href");
    const blogId = extractBlogId(href);
    if (!blogId) return;

    if (!neighborsMap.has(blogId)) {
      neighborsMap.set(blogId, {
        blogId,
        blogUrl: `https://blog.naver.com/${blogId}`,
        groupIds: new Set()
      });
    }

    if (groupIdOrNull != null) {
      neighborsMap
        .get(blogId)
        .groupIds.add(String(groupIdOrNull));
    }
  });
}

/**
 * ViewMoreFollowings 페이지 호출
 */
async function fetchFollowingsPage({ page, groupId }) {
  const cookie = process.env.NAVER_COOKIE || "";
  const params = new URLSearchParams();
  params.set("blogId", baseId);
  params.set("currentPage", String(page));
  if (groupId != null) params.set("groupId", String(groupId));

  const url = `${FOLLOWINGS_BASE}?${params.toString()}`;

  const res = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      Cookie: cookie
    }
  });

  return res.data;
}

/**
 * 1단계: 전체 이웃 수집 (groupId 없이)
 */
async function collectAllNeighbors() {
  const neighbors = new Map();

  for (let page = 1; page <= maxPages; page++) {
    console.log(
      `📥 [ALL] Fetch neighbors page ${page}`
    );
    let html;
    try {
      html = await fetchFollowingsPage({ page, groupId: null });
    } catch (e) {
      console.warn(
        `   ⚠️ [ALL] Page ${page} load failed: ${e.message}`
      );
      break;
    }

    const before = neighbors.size;
    collectFromFollowingsHtml(html, neighbors, null);
    const added = neighbors.size - before;

    console.log(
      `   👥 [ALL] Total: ${neighbors.size} (page ${page}, +${added})`
    );

    if (page > 1 && added === 0) {
      console.log("   ⛔ [ALL] No new neighbors. Stop.");
      break;
    }

    await sleep(delayMs);
  }

  return neighbors;
}

/**
 * 2단계: groups.js 기준 그룹 멤버십 채우기
 */
async function enrichWithGroups(neighbors, groupList) {
  if (!groupList.length) {
    console.log("⚠️ 그룹 정의가 없어 groupId 매핑은 생략합니다.");
    return;
  }

  console.log(
    `🔎 그룹 멤버십 스캔 (GROUPS: ${groupList
      .map((g) => `${g.id}:${g.name}`)
      .join(", ")})`
  );

  for (const g of groupList) {
    const gid = g.id;
    for (let page = 1; page <= maxPages; page++) {
      console.log(
        `📥 [GROUP ${gid}] ${g.name} - page ${page}`
      );

      let html;
      try {
        html = await fetchFollowingsPage({ page, groupId: gid });
      } catch (e) {
        console.warn(
          `   ⚠️ [GROUP ${gid}] Page ${page} load failed: ${e.message}`
        );
        break;
      }

      const before = countGroupMembers(neighbors, gid);
      collectFromFollowingsHtml(html, neighbors, gid);
      const after = countGroupMembers(neighbors, gid);
      const added = after - before;

      console.log(
        `   👥 [GROUP ${gid}] members: ${after} (page ${page}, +${added})`
      );

      if (page > 1 && added === 0) {
        console.log(
          `   ⛔ [GROUP ${gid}] No new members. Stop.`
        );
        break;
      }

      await sleep(delayMs);
    }
  }
}

function countGroupMembers(neighbors, gid) {
  const key = String(gid);
  let cnt = 0;
  for (const n of neighbors.values()) {
    if (n.groupIds.has(key)) cnt++;
  }
  return cnt;
}

/**
 * 3단계: 인플루언서 여부 확인
 * 인플루언서 여부 & 인플루언서 ID/URL 탐지
 *
 * 우선순위:
 *  1) 블로그 HTML 안에서 in.naver.com/{handle} 링크 찾기
 *  2) 없으면 in.naver.com/{blogId} 직접 확인 (동일 ID인 케이스용)
 */
async function detectInfluencerForBlog(blogId) {
  const blogUrl = `https://blog.naver.com/${blogId}`;
  let influencerId = null;

  // 1차: 블로그 메인 HTML에서 in.naver.com 링크 탐색
  try {
    const res = await axios.get(blogUrl, {
      maxRedirects: 5,
      headers: { "User-Agent": UA }
    });

    const html = res.data;
    const $ = cheerio.load(html);

    // a 태그 href에서 in.naver.com/{handle} 찾기
    $("a[href*='in.naver.com/']").each((_, el) => {
      if (influencerId) return; // 첫 번째만 사용
      let href = $(el).attr("href") || "";
      if (!href) return;

      if (href.startsWith("//")) href = "https:" + href;
      if (!href.startsWith("http")) {
        // 상대경로 비슷하면 스킵
        return;
      }

      const m = href.match(/in\.naver\.com\/([^\/\?\s]+)/);
      if (m && m[1]) {
        const handle = m[1].trim();
        // 너무 짧거나 이상한 값 필터링 가능하지만 일단 그대로 사용
        influencerId = handle;
      }
    });

    // 혹시 HTML 안에 '인플루언서' / 'Influencer' 관련 표시만 있어도
    // (근데 handle이 없으면 매핑을 못 하니까 여기서는 Y만 주고 ID는 비워둘 수도 있음)
    if (!influencerId) {
      if (
        html.includes("in.naver.com") &&
        (html.includes("인플루언서") ||
          html.toLowerCase().includes("influencer"))
      ) {
        // 링크는 있는데 파싱을 못한 특이 케이스일 수 있으므로
        // 일단 isInfluencer=Y로만 처리하고, id는 비워둘 수도 있다.
        return {
          isInfluencer: "Y",
          influencerId: "",
          influencerUrl: ""
        };
      }
    }
  } catch (e) {
    // 블로그 로딩 실패 시, 아래 fallback만 사용
  }

  // 2차: 그래도 못 찾았고, blogId와 인플 ID가 동일한 케이스를 커버하고 싶으면
  if (!influencerId) {
    const candidate = blogId;
    const url = `https://in.naver.com/${candidate}`;
    try {
      const res = await axios.get(url, {
        maxRedirects: 0,
        validateStatus: (s) => s === 200 || (s >= 300 && s < 400),
        headers: { "User-Agent": UA }
      });

      if (res.status === 200) {
        const body =
          typeof res.data === "string"
            ? res.data
            : (res.data || "").toString();

        if (
          body.includes("인플루언서") ||
          body.toLowerCase().includes("influencer") ||
          body.includes("in.naver.com")
        ) {
          influencerId = candidate;
        }
      }
    } catch (e) {
      // 404 등은 그냥 N
    }
  }

  if (influencerId) {
    return {
      isInfluencer: "Y",
      influencerId,
      influencerUrl: `https://in.naver.com/${influencerId}`
    };
  }

  return {
    isInfluencer: "N",
    influencerId: "",
    influencerUrl: ""
  };
}

/**
 * 메인
 */
async function main() {
  try {
    const { groupList, groupMap } = await loadGroups();

    // 1) 전체 이웃
    const neighborsMap = await collectAllNeighbors();

    // 2) 그룹 멤버십
    await enrichWithGroups(neighborsMap, groupList);
    
    // 3) 인플루언서 여부 + 인플루언서 ID/URL
    const neighbors = Array.from(neighborsMap.values());
    for (let i = 0; i < neighbors.length; i++) {
      const n = neighbors[i];
      console.log(
        `⭐ [${i + 1}/${neighbors.length}] Detect influencer for: ${n.blogId}`
      );
      const info = await detectInfluencerForBlog(n.blogId);
      n.isInfluencer = info.isInfluencer;
      n.influencerId = info.influencerId;
      n.influencerUrl = info.influencerUrl;
      await sleep(300);
    }

    // 4) CSV 생성
    const header =
      "blogId,blogUrl,groupIds,groupNames,isInfluencer,influencerId,influencerUrl\n";

    const lines = neighbors.map((n) => {
      const gids = Array.from(n.groupIds || []);
      const gnames = gids
        .map((id) => groupMap[id] || "")
        .filter(Boolean)
        .join("|");

      return [
        n.blogId,
        n.blogUrl,
        gids.join("|"),
        gnames,
        n.isInfluencer || "N",
        n.influencerId || "",
        n.influencerUrl || ""
      ]
        .map((v) =>
          v != null ? String(v).replace(/"/g, '""') : ""
        )
        .map((v) => `"${v}"`)
        .join(",");
    });

    const csv = header + lines.join("\n");
    await fs.writeFile(
      "neighbor-followings-result.csv",
      csv,
      "utf8"
    );
    console.log("✅ Done. neighbor-followings-result.csv 생성 완료");
  } catch (e) {
    console.error("❌ Error:", e.message);
    process.exit(1);
  }
}

main();
