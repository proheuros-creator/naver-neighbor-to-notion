/**
 * groups.js
 * ───────────────────────────────────────────────
 * 이웃그룹 목록 정의 파일
 *
 * - id: Naver 이웃 그룹의 groupId
 * - name: Notion Group 열에 들어갈 이름
 * - groupId=0 (전체이웃)는 넣지 않습니다.
 *
 * ⚠️ 순서는 스크랩 순서입니다.
 * ⚠️ 새 그룹 생기면 배열에 한 줄만 추가하면 index.js가 자동으로 인식합니다.
 */

export const GROUPS = [
  { id: 4, name: "증권사" },  
  { id: 8, name: "투자(Youtube)" }, 
  //{ id: 5, name: "중국투자" },  
  { id: 3, name: "미국투자" }, 
  { id: 9, name: "에코" },
  { id: 2, name: "05.투자" },
  { id: 13, name: "04.Diligent" },
  { id: 14, name: "03.정리" },  
  { id: 7, name: "02.insight" },
  { id: 1, name: "01.daily" },
  // ✅ 새 그룹을 추가하려면 아래처럼 한 줄만 추가하세요.
  // { id: 15, name: "새그룹" },
];
