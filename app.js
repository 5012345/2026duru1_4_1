import CONFIG from './config.js';

// ==========================================
// 1. Firebase & Gemini SDK 설정 및 초기화
// ==========================================

// Firebase 모듈 동적 로드 (안정성을 위해 공식 CDN 사용)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, set, onValue, update, push, remove, get } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { getFirestore, collection, writeBatch, doc, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

let app, db, fs;
let isFirebaseConfigured = false;

try {
  const fbConf = CONFIG.FIREBASE_CONFIG;
  const hasValidApiKey = fbConf && fbConf.apiKey && fbConf.apiKey !== "YOUR_FIREBASE_API_KEY" && fbConf.apiKey.trim() !== "";
  const hasValidDbUrl = fbConf && fbConf.databaseURL && fbConf.databaseURL.startsWith("https://");

  if (hasValidApiKey && hasValidDbUrl) {
    app = initializeApp(fbConf);
    db = getDatabase(app);
    fs = getFirestore(app);
    isFirebaseConfigured = true;
    console.log("Firebase가 성공적으로 초기화되었습니다.");
  } else {
    console.warn("Firebase 설정이 올바르지 않거나 정의되지 않았습니다. 로컬 데모 모드로 작동합니다.");
  }
} catch (error) {
  console.error("Firebase 초기화 에러:", error);
}

// ==========================================
// 2. 상태 관리 변수
// ==========================================
let sessionId = localStorage.getItem('wood_connect4_session_id') || generateUUID();
localStorage.setItem('wood_connect4_session_id', sessionId);

let isLocalMode = false;
let currentRoomId = null;
let myPlayerId = sessionId; // 고유 ID로 세션 ID 사용
let myName = "";
let isHost = false;
let roomState = null;
let selectedTarget = null; // 사용자가 클릭한 목표 좌표 {x, y}
let prevCalculatedPreview = null; // 현재 반투명 미리보기로 표시 중인 좌표 {x, y}

// Rate Limiting 용 변수 (Gemini API 분당 10회 제한)
const rateLimitWindowMs = 60000; // 1분
const maxRequestsPerWindow = 10;
let geminiRequestTimestamps = [];

// ==========================================
// 3. UI 요소 참조
// ==========================================
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const waitingRoomPanel = document.getElementById('waiting-room-panel');
const playerNameInput = document.getElementById('player-name');
const createRoomBtn = document.getElementById('create-room-btn');
const roomCodeInput = document.getElementById('room-code-input');
const joinRoomBtn = document.getElementById('join-room-btn');
const displayRoomCode = document.getElementById('display-room-code');
const copyRoomCodeBtn = document.getElementById('copy-room-code-btn');
const waitingPlayersUl = document.getElementById('waiting-players-ul');
const startGameBtn = document.getElementById('start-game-btn');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const exitGameBtn = document.getElementById('exit-game-btn');

const currentTurnDisplay = document.getElementById('current-turn-display');
const turnPlayerName = document.getElementById('turn-player-name');
const ruleTipText = document.getElementById('rule-tip-text');
const coordinateBoard = document.getElementById('coordinate-board');
const stonesContainer = document.getElementById('stones-container');
const boardGridSvg = document.querySelector('.board-grid-svg');

const playersListContainer = document.getElementById('players-list-container');
const lastMoveDisplay = document.getElementById('last-move-display');
const coordXInput = document.getElementById('coord-x');
const coordYInput = document.getElementById('coord-y');
const inputValidationWarning = document.getElementById('input-validation-warning');
const submitCoordinateBtn = document.getElementById('submit-coordinate-btn');

const sageChatHistory = document.getElementById('sage-chat-history');
const toastMessage = document.getElementById('toast-message');

const teacherDashboardBtn = document.getElementById('teacher-dashboard-btn');
const teacherDashboardModal = document.getElementById('teacher-dashboard-modal');
const closeDashboardBtn = document.getElementById('close-dashboard-btn');
const teacherAuthSection = document.getElementById('teacher-auth-section');
const teacherStatsSection = document.getElementById('teacher-stats-section');
const teacherPasswordInput = document.getElementById('teacher-password');
const submitAuthBtn = document.getElementById('submit-auth-btn');
const authErrorMsg = document.getElementById('auth-error-msg');

const statTotalErrors = document.getElementById('stat-total-errors');
const statAiRatio = document.getElementById('stat-ai-ratio');
const statWorstQuadrant = document.getElementById('stat-worst-quadrant');
const errorLogsTbody = document.getElementById('error-logs-tbody');

// 차트 객체 참조
let quadrantChart = null;
let hintUsageChart = null;

// 플레이어 돌 디자인 매핑 (이모지 & 그라데이션 색상)
const playerDesigns = [
  { emoji: "🌰", text: "도토리", color: "radial-gradient(circle, #e29c52 0%, #8b5a2b 100%)", class: "chestnut" },
  { emoji: "🍃", text: "나뭇잎", color: "radial-gradient(circle, #a8e063 0%, #2d5a27 100%)", class: "leaf" },
  { emoji: "🍁", text: "단풍잎", color: "radial-gradient(circle, #f857a6 0%, #ff5858 100%)", class: "maple" },
  { emoji: "🪨", text: "조약돌", color: "radial-gradient(circle, #b9b9b9 0%, #535353 100%)", class: "pebble" }
];

// ==========================================
// 4. 초기 실행 및 이벤트 바인딩
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // Lucide 아이콘 초기화
  lucide.createIcons();
  
  // 닉네임 입력란 복원
  const savedName = localStorage.getItem('wood_connect4_player_name');
  if (savedName) playerNameInput.value = savedName;

  // 이벤트 바인딩
  createRoomBtn.addEventListener('click', handleCreateRoom);
  joinRoomBtn.addEventListener('click', handleJoinRoom);
  copyRoomCodeBtn.addEventListener('click', copyRoomCode);
  startGameBtn.addEventListener('click', handleStartGame);
  leaveRoomBtn.addEventListener('click', handleLeaveRoom);
  exitGameBtn.addEventListener('click', handleLeaveRoom);
  
  // 좌표 입력란 변경 시 실시간 미리보기 및 X/Y 동시 변경 검증
  coordXInput.addEventListener('input', handleCoordinateChange);
  coordYInput.addEventListener('input', handleCoordinateChange);
  
  // 제출 버튼에 Lodash 스타일 Debounce 적용 (1초)
  submitCoordinateBtn.addEventListener('click', debounce(handleSubmitCoordinate, 1000));
  
  // 교사용 대시보드
  teacherDashboardBtn.addEventListener('click', openDashboard);
  closeDashboardBtn.addEventListener('click', closeDashboard);
  submitAuthBtn.addEventListener('click', handleTeacherAuth);
  teacherPasswordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleTeacherAuth();
  });
  
  // 바둑판 드로잉 및 클릭 영역 세팅
  drawBoard();
  setupBoardInteractions();
});

// ==========================================
// 5. 바둑판 좌표평면 그리기 (SVG)
// ==========================================
function drawBoard() {
  const size = 600;
  const padding = 50; // 여백 (-5 ~ 5 눈금 매핑을 위해)
  const steps = 10;
  const stepSize = (size - padding * 2) / steps; // 50px 간격
  
  let svgContent = '';

  // 격자선 (얇은 나무색 선)
  for (let i = 0; i <= steps; i++) {
    const pos = padding + i * stepSize;
    // 세로선
    svgContent += `<line x1="${pos}" y1="${padding}" x2="${pos}" y2="${size - padding}" stroke="#8b6c42" stroke-width="1" stroke-opacity="0.3" />`;
    // 가로선
    svgContent += `<line x1="${padding}" y1="${pos}" x2="${size - padding}" y2="${pos}" stroke="#8b6c42" stroke-width="1" stroke-opacity="0.3" />`;
  }

  // X축, Y축 (굵은 메인 축)
  const center = size / 2; // 300
  // Y축
  svgContent += `<line x1="${center}" y1="${padding - 10}" x2="${center}" y2="${size - padding + 10}" stroke="#3d2314" stroke-width="3.5" />`;
  // X축
  svgContent += `<line x1="${padding - 10}" y1="${center}" x2="${size - padding + 10}" y2="${center}" stroke="#3d2314" stroke-width="3.5" />`;

  // 축 화살표
  svgContent += `<polygon points="${center},${padding - 20} ${center - 6},${padding - 10} ${center + 6},${padding - 10}" fill="#3d2314" />`; // Y축 위 화살표
  svgContent += `<polygon points="${size - padding + 20},${center} ${size - padding + 10},${center - 6} ${size - padding + 10},${center + 6}" fill="#3d2314" />`; // X축 오른쪽 화살표

  // 축 이름 라벨
  svgContent += `<text x="${size - padding + 25}" y="${center + 15}" fill="#3d2314" font-family="Outfit" font-size="16" font-weight="bold">x</text>`;
  svgContent += `<text x="${center - 18}" y="${padding - 12}" fill="#3d2314" font-family="Outfit" font-size="16" font-weight="bold">y</text>`;

  // 눈금선 및 숫자 라벨링
  for (let i = -5; i <= 5; i++) {
    if (i === 0) continue; // 원점은 따로 표시
    
    const offset = i * stepSize;
    
    // X축 눈금
    svgContent += `<line x1="${center + offset}" y1="${center - 4}" x2="${center + offset}" y2="${center + 4}" stroke="#3d2314" stroke-width="2" />`;
    // X축 라벨
    svgContent += `<text x="${center + offset}" y="${center + 20}" fill="#3d2314" font-family="Outfit" font-size="12" font-weight="bold" text-anchor="middle">${i}</text>`;
    
    // Y축 눈금
    svgContent += `<line x1="${center - 4}" y1="${center - offset}" x2="${center + 4}" y2="${center - offset}" stroke="#3d2314" stroke-width="2" />`;
    // Y축 라벨
    svgContent += `<text x="${center - 15}" y="${center - offset + 4}" fill="#3d2314" font-family="Outfit" font-size="12" font-weight="bold" text-anchor="end">${i}</text>`;
  }

  // 원점(0) 라벨
  svgContent += `<text x="${center - 12}" y="${center + 18}" fill="#3d2314" font-family="Outfit" font-size="12" font-weight="bold">O</text>`;

  boardGridSvg.innerHTML = svgContent;
}

// 수학적 좌표 (-5 ~ 5) -> 화면 픽셀 좌표 (CSS % 또는 px) 변환
function mathToPercent(x, y) {
  // 보드 크기가 600px이고 패딩이 50px임.
  // 600px 기준 mathToPx: pxX = 300 + x * 50, pxY = 300 - y * 50
  // 이를 백분율로 환산하면: %X = pxX / 600 * 100, %Y = pxY / 600 * 100
  const pxX = 300 + x * 50;
  const pxY = 300 - y * 50;
  return {
    x: (pxX / 6) + '%',
    y: (pxY / 6) + '%'
  };
}

// ==========================================
// 6. 바둑판 상호작용 및 클릭 이벤트
// ==========================================
function setupBoardInteractions() {
  // 교차점(그리드 클릭용 히트박스) 생성
  // 보드에 마우스 호버 및 클릭을 위한 절대위치 둥근 점 배치
  const hitboxesContainer = document.createElement('div');
  hitboxesContainer.className = 'hitboxes-container';
  hitboxesContainer.style.position = 'absolute';
  hitboxesContainer.style.top = '0';
  hitboxesContainer.style.left = '0';
  hitboxesContainer.style.width = '100%';
  hitboxesContainer.style.height = '100%';
  hitboxesContainer.style.zIndex = '4'; // 돌(z:3)보다 위에 배치하여 클릭성 보장
  coordinateBoard.appendChild(hitboxesContainer);

  for (let x = -5; x <= 5; x++) {
    for (let y = -5; y <= 5; y++) {
      const pos = mathToPercent(x, y);
      const hitbox = document.createElement('div');
      hitbox.className = 'grid-hitbox';
      hitbox.style.position = 'absolute';
      hitbox.style.left = pos.x;
      hitbox.style.top = pos.y;
      hitbox.style.width = '30px';
      hitbox.style.height = '30px';
      hitbox.style.transform = 'translate(-50%, -50%)';
      hitbox.style.borderRadius = '50%';
      hitbox.style.cursor = 'pointer';
      // hitbox.style.background = 'rgba(0,0,0,0.05)'; // 개발용 테스트 시각화
      
      // 클릭 시 해당 교차점을 임시 지정
      hitbox.addEventListener('click', () => handleBoardClick(x, y));
      hitboxesContainer.appendChild(hitbox);
    }
  }
}

// 바둑판 클릭 처리
function handleBoardClick(x, y) {
  // 내 차례가 아니면 클릭 무시
  if (!isMyTurn()) {
    showToast("지금은 당신의 차례가 아닙니다.");
    return;
  }

  // 이미 돌이 놓여 있는 자리라면 클릭 무시
  if (roomState && roomState.stones && roomState.stones[`${x}_${y}`]) {
    showToast("이미 돌이 놓여 있는 자리입니다.");
    return;
  }

  // 클릭한 대상 설정
  selectedTarget = { x, y };

  // 클릭한 좌표를 입력창에 자동 입력
  coordXInput.value = x;
  coordYInput.value = y;

  // 실시간 검증 및 미리보기 업데이트
  handleCoordinateChange();
}

// X, Y 입력창 값 변경 또는 클릭 감지 시 동작
function handleCoordinateChange() {
  const xVal = parseInt(coordXInput.value);
  const yVal = parseInt(coordYInput.value);

  // 입력값이 빈칸이거나 범위를 초과하는 경우 미리보기 제거 및 버튼 비활성화
  if (isNaN(xVal) || isNaN(yVal) || xVal < -5 || xVal > 5 || yVal < -5 || yVal > 5) {
    removePreviewStone();
    submitCoordinateBtn.disabled = true;
    inputValidationWarning.classList.add('hidden');
    return;
  }

  // 규칙 검증: 첫 턴이 아니고, 이전 수(lastMove)가 있을 때 X와 Y 모두 변경 시 경고
  const lastMove = roomState ? roomState.lastMove : null;
  if (lastMove) {
    const isXChanged = (xVal !== lastMove.x);
    const isYChanged = (yVal !== lastMove.y);

    if (isXChanged && isYChanged) {
      // 둘 다 변경한 경우 경고창 띄우고 버튼 비활성화
      inputValidationWarning.classList.remove('hidden');
      submitCoordinateBtn.disabled = true;
      removePreviewStone();
      return;
    }
  }

  // 규칙 통과 시 경고 숨김 및 제출 버튼 활성화 (턴 주권자만 활성화)
  inputValidationWarning.classList.add('hidden');
  submitCoordinateBtn.disabled = !isMyTurn();

  // 실시간 반투명 미리보기 돌 렌더링
  renderPreviewStone(xVal, yVal);
}

// 반투명 미리보기 돌 그리기
function renderPreviewStone(x, y) {
  // 기존 프리뷰 돌 제거
  removePreviewStone();

  // 만약 이미 그 자리에 돌이 존재하면 프리뷰를 안 그림
  if (roomState && roomState.stones && roomState.stones[`${x}_${y}`]) {
    return;
  }

  const myDesign = getMyDesign();
  const pos = mathToPercent(x, y);
  
  const preview = document.createElement('div');
  preview.id = 'active-preview-stone';
  preview.className = `stone preview-stone ${myDesign.class}`;
  preview.style.left = pos.x;
  preview.style.top = pos.y;
  preview.style.background = myDesign.color;
  preview.innerHTML = myDesign.emoji;

  stonesContainer.appendChild(preview);
  prevCalculatedPreview = { x, y };
}

function removePreviewStone() {
  const preview = document.getElementById('active-preview-stone');
  if (preview) {
    preview.remove();
  }
  prevCalculatedPreview = null;
}

// 내 디자인 가져오기 (방 참가 순서에 따른 배정)
function getMyDesign() {
  if (!roomState || !roomState.players) return playerDesigns[0];
  const playerArr = roomState.turnOrder || Object.keys(roomState.players);
  const index = playerArr.indexOf(myPlayerId);
  return playerDesigns[index >= 0 ? index : 0];
}

// ==========================================
// 7. 실시간 멀티플레이 로직 (Firebase)
// ==========================================

// 방 만들기
async function handleCreateRoom() {
  if (!validateName()) return;

  if (!isFirebaseConfigured) {
    isLocalMode = true;
    currentRoomId = "LOCAL_ROOM";
    isHost = true;

    roomState = {
      roomId: "LOCAL_ROOM",
      status: "playing",
      hostId: myPlayerId,
      players: {
        [myPlayerId]: {
          name: myName,
          isHost: true,
          emoji: playerDesigns[0].emoji
        },
        "bot_squirrel": {
          name: "다람쥐 봇 🐿️",
          isHost: false,
          emoji: playerDesigns[1].emoji
        }
      },
      turnOrder: [myPlayerId, "bot_squirrel"],
      currentTurnIndex: 0,
      lastMove: null,
      stones: {},
      winner: null,
      createdAt: Date.now()
    };

    showToast("⚠️ Firebase 미설정으로 로컬 봇 대전 모드로 시작합니다.");
    lobbyScreen.classList.remove('active');
    gameScreen.classList.add('active');
    
    renderGameUI(roomState);
    addSystemChatMessage("✨ 다람쥐 봇과 1:1 사목 대전을 시작합니다! 선공은 당신입니다.");
    return;
  }

  const roomCode = generateRoomCode();
  currentRoomId = roomCode;
  isHost = true;

  const initialRoomState = {
    roomId: roomCode,
    status: "waiting",
    hostId: myPlayerId,
    players: {
      [myPlayerId]: {
        name: myName,
        isHost: true,
        emoji: playerDesigns[0].emoji
      }
    },
    turnOrder: [myPlayerId],
    currentTurnIndex: 0,
    lastMove: null,
    stones: {},
    winner: null,
    createdAt: Date.now()
  };

  try {
    await set(ref(db, `rooms/${roomCode}`), initialRoomState);
    showToast(`방 [${roomCode}]이 개설되었습니다!`);
    enterWaitingRoom(roomCode);
    listenToRoom(roomCode);
  } catch (error) {
    console.error("방 생성 에러:", error);
    showToast("방을 만드는 데 실패했습니다.");
  }
}

// 방 참여하기
async function handleJoinRoom() {
  if (!validateName()) return;

  if (!isFirebaseConfigured) {
    showToast("로컬 모드에서는 방을 직접 만들어 봇 대전을 플레이해 주세요.");
    return;
  }

  const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    showToast("방 코드 6자리를 올바르게 입력해주세요.");
    return;
  }

  try {
    const snapshot = await get(ref(db, `rooms/${code}`));
    if (!snapshot.exists()) {
      showToast("존재하지 않는 방 코드입니다.");
      return;
    }

    const room = snapshot.val();
    if (room.status !== "waiting") {
      showToast("이미 게임이 시작되었거나 종료된 방입니다.");
      return;
    }

    const playersCount = Object.keys(room.players || {}).length;
    if (playersCount >= 4) {
      showToast("방 인원이 꽉 찼습니다 (최대 4인).");
      return;
    }

    currentRoomId = code;
    isHost = false;

    // 플레이어 정보 추가
    const nextDesignIndex = playersCount; // 0~3 인덱스 배정
    const myDesign = playerDesigns[nextDesignIndex];

    const updates = {};
    updates[`rooms/${code}/players/${myPlayerId}`] = {
      name: myName,
      isHost: false,
      emoji: myDesign.emoji
    };
    
    // turnOrder 배열 업데이트
    const updatedTurnOrder = [...(room.turnOrder || [])];
    if (!updatedTurnOrder.includes(myPlayerId)) {
      updatedTurnOrder.push(myPlayerId);
    }
    updates[`rooms/${code}/turnOrder`] = updatedTurnOrder;

    await update(ref(db), updates);
    showToast("대기방에 입장했습니다!");
    enterWaitingRoom(code);
    listenToRoom(code);
  } catch (error) {
    console.error("방 참가 에러:", error);
    showToast("방 참가 중 오류가 발생했습니다.");
  }
}

// 방 실시간 구독
function listenToRoom(roomId) {
  const roomRef = ref(db, `rooms/${roomId}`);
  onValue(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
      // 방이 터졌거나 퇴장당한 경우 로비로 이동
      if (currentRoomId) {
        showToast("방이 존재하지 않거나 사라졌습니다.");
        resetToLobby();
      }
      return;
    }

    const data = snapshot.val();
    roomState = data;
    
    // 호스트 여부 체크 유지
    isHost = (data.hostId === myPlayerId);

    // 1. 대기 모드 UI 처리
    if (data.status === "waiting") {
      renderWaitingRoomPlayers(data);
      if (isHost) {
        // 인원수가 2명 이상일 때 게임 시작 버튼 활성화
        const playerNum = Object.keys(data.players || {}).length;
        startGameBtn.disabled = (playerNum < 2);
      }
    } 
    // 2. 게임 중 UI 처리
    else if (data.status === "playing") {
      if (lobbyScreen.classList.contains('active')) {
        // 화면 전환
        lobbyScreen.classList.remove('active');
        gameScreen.classList.add('active');
        addSystemChatMessage("✨ 게임이 시작되었습니다! 대결을 펼쳐보세요.");
      }
      renderGameUI(data);
    }
    // 3. 게임 완료 UI 처리
    else if (data.status === "finished") {
      renderGameUI(data);
      if (data.winner) {
        const winnerName = data.players[data.winner]?.name || "비공개";
        addSystemChatMessage(`🏆 승리자: ${winnerName}! 축하합니다!`);
        showToast(`🎉 게임 종료! 승리자는 [${winnerName}]입니다.`);
        
        // 4목 애니메이션 연출을 위해 승리 리스트 반짝이게 만듬
        if (data.winningStones) {
          highlightWinningStones(data.winningStones);
        }

        // 배치 쓰기 완료 알림을 호스트만 수행하도록 하여 중복 Firestore 호출 방지
        if (isHost && !data.isLogged) {
          batchWriteAnalyticsToFirestore();
          // 중복 전송 방지를 위해 Realtime DB의 플래그 설정
          update(ref(db, `rooms/${roomId}`), { isLogged: true });
        }
      }
    }
  });
}

// 대기실 UI 렌더링
function renderWaitingRoomPlayers(room) {
  waitingPlayersUl.innerHTML = "";
  const order = room.turnOrder || [];
  
  order.forEach((pId, idx) => {
    const pInfo = room.players[pId];
    if (!pInfo) return;

    const li = document.createElement('li');
    li.innerHTML = `
      <div class="player-info-item">
        <span class="player-emoji">${playerDesigns[idx]?.emoji || '🌰'}</span>
        <span>${escapeHtml(pInfo.name)}</span>
        ${pInfo.isHost ? '<span class="host-badge">방장</span>' : ''}
        ${pId === myPlayerId ? '<span style="color:#888; font-size:0.8rem;">(나)</span>' : ''}
      </div>
    `;
    waitingPlayersUl.appendChild(li);
  });
}

// 게임룸 들어갈 시 대기방 패널 띄우기
function enterWaitingRoom(roomCode) {
  displayRoomCode.textContent = roomCode;
  waitingRoomPanel.classList.remove('hidden');
  
  // 방장은 시작 버튼 노출, 일반 유저는 대기 텍스트 등
  if (isHost) {
    startGameBtn.classList.remove('hidden');
    startGameBtn.disabled = true;
  } else {
    startGameBtn.classList.add('hidden');
  }
}

// 로비로 돌아가기 초기화
function resetToLobby() {
  currentRoomId = null;
  roomState = null;
  selectedTarget = null;
  prevCalculatedPreview = null;
  
  waitingRoomPanel.classList.add('hidden');
  gameScreen.classList.remove('active');
  lobbyScreen.classList.add('active');
  
  stonesContainer.innerHTML = "";
  sageChatHistory.innerHTML = `
    <div class="chat-message system">
      <p>좌표평면 위에서 돌을 놓고 싶은 곳을 클릭하면 입력창에 자동으로 입력된단다. 틀려도 괜찮으니 차근차근 순서쌍을 적어보려무나.</p>
    </div>
  `;
}

// 방 나가기
async function handleLeaveRoom() {
  if (!currentRoomId || !checkFirebaseConnection()) {
    resetToLobby();
    return;
  }

  const roomId = currentRoomId;
  const isLeavingHost = isHost;

  resetToLobby();

  try {
    // 룸 참조 끊고
    if (isLeavingHost) {
      // 방장이 나가면 방 자체를 삭제
      await remove(ref(db, `rooms/${roomId}`));
    } else {
      // 일반 플레이어 퇴장 처리
      const snapshot = await get(ref(db, `rooms/${roomId}`));
      if (snapshot.exists()) {
        const room = snapshot.val();
        
        // players 객체에서 나 제거
        if (room.players && room.players[myPlayerId]) {
          delete room.players[myPlayerId];
        }
        
        // turnOrder에서 나 제거
        const updatedTurnOrder = (room.turnOrder || []).filter(id => id !== myPlayerId);
        
        const updates = {};
        updates[`rooms/${roomId}/players`] = room.players || {};
        updates[`rooms/${roomId}/turnOrder`] = updatedTurnOrder;
        
        // 턴 인덱스가 인원을 초과하지 않게 조절
        let nextTurnIdx = room.currentTurnIndex;
        if (nextTurnIdx >= updatedTurnOrder.length) {
          nextTurnIdx = 0;
        }
        updates[`rooms/${roomId}/currentTurnIndex`] = nextTurnIdx;

        await update(ref(db), updates);
      }
    }
  } catch (err) {
    console.error("방 퇴장 처리 중 에러:", err);
  }
}

// 게임 시작하기 (방장 전용)
async function handleStartGame() {
  if (!isHost || !currentRoomId) return;

  const updates = {
    status: "playing",
    currentTurnIndex: 0
  };

  try {
    await update(ref(db, `rooms/${currentRoomId}`), updates);
  } catch (error) {
    console.error("게임 시작 에러:", error);
    showToast("게임을 시작할 수 없습니다.");
  }
}

// ==========================================
// 8. 게임 화면 UI 렌더링 및 턴 제어
// ==========================================
function renderGameUI(room) {
  // 1. 차례 지시기 갱신
  const turnOrder = room.turnOrder || [];
  const currentTurnPlayerId = turnOrder[room.currentTurnIndex];
  const isMyTurnNow = (currentTurnPlayerId === myPlayerId);
  
  const currentTurnPlayerName = room.players[currentTurnPlayerId]?.name || "알 수 없음";
  turnPlayerName.textContent = currentTurnPlayerName;
  
  // 턴 알리미 펄스 인디케이터 색상
  const currentTurnDesign = playerDesigns[room.currentTurnIndex] || playerDesigns[0];
  document.querySelector('.pulse-indicator').style.backgroundColor = isMyTurnNow ? '#6fcf97' : '#eb5757';

  // 2. 가이드 메시지 갱신
  const lastMove = room.lastMove;
  if (!lastMove) {
    ruleTipText.textContent = "첫 번째 돌은 좌표평면 상의 임의의 위치에 자유롭게 놓을 수 있습니다!";
    lastMoveDisplay.innerHTML = `<i data-lucide="help-circle"></i> 아직 첫 돌이 놓이지 않았습니다.`;
    lastMoveDisplay.className = "last-move-badge";
  } else {
    const lastPlayerName = room.players[lastMove.playerId]?.name || "이전 플레이어";
    ruleTipText.textContent = `이전 돌 [${lastPlayerName}의 ${lastMove.emoji}]의 좌표 (${lastMove.x}, ${lastMove.y})에서 X 또는 Y 중 하나만 변경하여 선택해야 합니다.`;
    lastMoveDisplay.innerHTML = `<i data-lucide="compass"></i> (${lastMove.x}, ${lastMove.y}) <span>[${lastMove.emoji}]</span>`;
    lastMoveDisplay.className = "last-move-badge has-move";
  }
  lucide.createIcons();

  // 3. 플레이어 리스트 패널 렌더링
  playersListContainer.innerHTML = "";
  turnOrder.forEach((pId, idx) => {
    const pInfo = room.players[pId];
    if (!pInfo) return;

    const card = document.createElement('div');
    card.className = `player-card ${pId === currentTurnPlayerId ? 'active-turn' : ''}`;
    card.innerHTML = `
      <div class="player-info-item">
        <span class="player-emoji">${playerDesigns[idx]?.emoji || '🌰'}</span>
        <span>${escapeHtml(pInfo.name)}</span>
        ${pId === myPlayerId ? '<span style="color:#999; font-size:0.75rem;">(나)</span>' : ''}
      </div>
    `;
    playersListContainer.appendChild(card);
  });

  // 4. 놓인 돌들 렌더링
  stonesContainer.innerHTML = "";
  
  // 만약 내 미리보기가 이미 계산되어 입력란에 매치되어 있으면 그 값을 복원해 프리뷰 돌을 그려줍니다
  if (isMyTurnNow && prevCalculatedPreview) {
    renderPreviewStone(prevCalculatedPreview.x, prevCalculatedPreview.y);
  }

  // 데이터베이스의 돌 렌더링
  const stones = room.stones || {};
  Object.keys(stones).forEach(key => {
    const [sx, sy] = key.split('_').map(Number);
    const stoneInfo = stones[key];
    const pos = mathToPercent(sx, sy);

    const stoneDiv = document.createElement('div');
    stoneDiv.className = `stone`;
    
    // 각 플레이어 디자인 클래스 매핑
    const pIdx = turnOrder.indexOf(stoneInfo.playerId);
    const design = playerDesigns[pIdx >= 0 ? pIdx : 0];
    stoneDiv.classList.add(design.class);
    
    stoneDiv.style.left = pos.x;
    stoneDiv.style.top = pos.y;
    stoneDiv.style.background = design.color;
    stoneDiv.innerHTML = design.emoji;
    stoneDiv.dataset.coord = key; // "x_y" 저장

    stonesContainer.appendChild(stoneDiv);
  });

  // 5. 이전 수 가이드 라인 렌더링 (SVG 위에 숲속 덩굴 가이드라인 표시)
  drawLastMoveGuideLines(lastMove);

  // 6. 입력 제어
  if (room.status === "finished") {
    // 게임 종료 시 입력 비활성화
    coordXInput.disabled = true;
    coordYInput.disabled = true;
    submitCoordinateBtn.disabled = true;
  } else {
    coordXInput.disabled = !isMyTurnNow;
    coordYInput.disabled = !isMyTurnNow;
    // 제출 버튼은 실시간 좌표 검증을 따르므로 여기서 섣불리 켜지 않고 handleCoordinateChange()에 넘김
  }
}

// 마지막 수가 놓인 라인을 강조하여 다음 참가자가 놓을 수 있는 세로/가로줄 안내
function drawLastMoveGuideLines(lastMove) {
  // 기존 가이드 라인 SVG 요소들 제거
  const oldGuides = boardGridSvg.querySelectorAll('.last-move-guide-line');
  oldGuides.forEach(el => el.remove());

  if (!lastMove) return;

  const size = 600;
  const padding = 50;
  const steps = 10;
  const stepSize = (size - padding * 2) / steps;

  // lastMove 좌표를 화면 픽셀로 환산
  const pxX = 300 + lastMove.x * 50;
  const pxY = 300 - lastMove.y * 50;

  // 가로 가이드 라인 (y = lastMove.y)
  const horizLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  horizLine.setAttribute('x1', padding.toString());
  horizLine.setAttribute('y1', pxY.toString());
  horizLine.setAttribute('x2', (size - padding).toString());
  horizLine.setAttribute('y2', pxY.toString());
  horizLine.setAttribute('stroke', '#f2c94c'); // 골드
  horizLine.setAttribute('stroke-width', '2.5');
  horizLine.setAttribute('stroke-dasharray', '6,4');
  horizLine.setAttribute('stroke-opacity', '0.6');
  horizLine.setAttribute('class', 'last-move-guide-line');

  // 세로 가이드 라인 (x = lastMove.x)
  const vertLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  vertLine.setAttribute('x1', pxX.toString());
  vertLine.setAttribute('y1', padding.toString());
  vertLine.setAttribute('x2', pxX.toString());
  vertLine.setAttribute('y2', (size - padding).toString());
  vertLine.setAttribute('stroke', '#f2c94c');
  vertLine.setAttribute('stroke-width', '2.5');
  vertLine.setAttribute('stroke-dasharray', '6,4');
  vertLine.setAttribute('stroke-opacity', '0.6');
  vertLine.setAttribute('class', 'last-move-guide-line');

  // SVG에 부착
  boardGridSvg.appendChild(horizLine);
  boardGridSvg.appendChild(vertLine);
}

// 4목 승리 시 반짝이는 효과
function highlightWinningStones(winningCoords) {
  winningCoords.forEach(coordKey => {
    const stoneEl = stonesContainer.querySelector(`[data-coord="${coordKey}"]`);
    if (stoneEl) {
      stoneEl.classList.add('winning-stone');
    }
  });
}

// 내가 지금 턴인지 판별
function isMyTurn() {
  if (!roomState || roomState.status !== "playing") return false;
  const turnOrder = roomState.turnOrder || [];
  return turnOrder[roomState.currentTurnIndex] === myPlayerId;
}

// ==========================================
// 9. 순서쌍 검증 및 돌 제출 로직 (Debounced)
// ==========================================
async function handleSubmitCoordinate() {
  if (!isMyTurn()) return;

  const xVal = parseInt(coordXInput.value);
  const yVal = parseInt(coordYInput.value);

  if (isNaN(xVal) || isNaN(yVal) || xVal < -5 || xVal > 5 || yVal < -5 || yVal > 5) {
    showToast("좌표평면 범위(-5 ~ 5) 안의 값을 정확히 입력해주세요.");
    return;
  }

  // 1. 사용자가 클릭한 목표 좌표(selectedTarget)가 있는지 확인
  if (!selectedTarget) {
    showToast("바둑판에서 돌을 놓을 교차점을 먼저 클릭하여 선택해 주세요.");
    return;
  }

  // 2. 규칙 검증: 이전 돌의 X 또는 Y 중 하나만 변경했는지
  const lastMove = roomState.lastMove;
  if (lastMove) {
    const isXChanged = (selectedTarget.x !== lastMove.x);
    const isYChanged = (selectedTarget.y !== lastMove.y);
    
    if (isXChanged && isYChanged) {
      showToast("이전 돌의 X좌표와 Y좌표 중 하나만 변경할 수 있습니다!");
      return;
    }
  }

  // 3. 클릭한 목표 좌표와 입력한 순서쌍 일치 여부 판별
  const isCorrect = (xVal === selectedTarget.x && yVal === selectedTarget.y);

  if (isCorrect) {
    // [정답 제출]
    // 돌 배치 및 턴 전환
    await placeStoneAndNextTurn(xVal, yVal);
    
    // 입력창 및 선택 초기화
    coordXInput.value = "";
    coordYInput.value = "";
    selectedTarget = null;
    removePreviewStone();
  } else {
    // [오답 제출]
    // 턴이 넘어가지 않음
    showToast("오답입니다! 입력한 순서쌍과 선택한 점의 좌표가 일치하지 않습니다.");
    
    // AI 힌트 및 로그 기록 진행
    await handleWrongAnswer(selectedTarget, { x: xVal, y: yVal });
  }
}

// 정답 돌 배치 및 실시간 DB 업데이트
async function placeStoneAndNextTurn(x, y) {
  if (isLocalMode) {
    const key = `${x}_${y}`;
    const stones = { ...(roomState.stones || {}) };
    stones[key] = {
      playerId: myPlayerId,
      timestamp: Date.now()
    };

    const nextMove = {
      x: x,
      y: y,
      playerId: myPlayerId,
      emoji: getMyDesign().emoji
    };

    // 4목 승리 판별
    const hasWon = checkConnect4(stones, x, y, myPlayerId);
    const updatedStatus = hasWon ? "finished" : "playing";
    const winner = hasWon ? myPlayerId : null;

    // 턴 전환 계산
    let nextTurnIndex = (roomState.currentTurnIndex + 1) % roomState.turnOrder.length;

    roomState.stones = stones;
    roomState.lastMove = nextMove;
    roomState.currentTurnIndex = nextTurnIndex;
    roomState.status = updatedStatus;
    roomState.winner = winner;

    if (hasWon) {
      const winStones = getWinningLine(stones, x, y, myPlayerId);
      roomState.winningStones = winStones;
    }

    renderGameUI(roomState);

    if (hasWon) {
      addSystemChatMessage(`🏆 승리자: ${myName}! 축하합니다!`);
      showToast(`🎉 게임 종료! 승리자는 [${myName}]입니다.`);
      highlightWinningStones(roomState.winningStones);
      batchWriteAnalyticsToFirestore();
    } else {
      // 봇의 차례 실행
      setTimeout(handleBotTurn, 1500);
    }
    return;
  }

  if (!checkFirebaseConnection()) return;

  const key = `${x}_${y}`;
  const stones = { ...(roomState.stones || {}) };
  stones[key] = {
    playerId: myPlayerId,
    timestamp: Date.now()
  };

  const nextMove = {
    x: x,
    y: y,
    playerId: myPlayerId,
    emoji: getMyDesign().emoji
  };

  // 4목 승리 판별
  const hasWon = checkConnect4(stones, x, y, myPlayerId);
  const updatedStatus = hasWon ? "finished" : "playing";
  const winner = hasWon ? myPlayerId : null;

  // 턴 전환 계산
  let nextTurnIndex = roomState.currentTurnIndex;
  if (!hasWon) {
    nextTurnIndex = (roomState.currentTurnIndex + 1) % roomState.turnOrder.length;
  }

  const updates = {
    stones: stones,
    lastMove: nextMove,
    currentTurnIndex: nextTurnIndex,
    status: updatedStatus,
    winner: winner
  };

  if (hasWon) {
    // 승리 라인 추출해서 DB에 저장
    const winStones = getWinningLine(stones, x, y, myPlayerId);
    updates.winningStones = winStones;
  }

  try {
    await update(ref(db, `rooms/${currentRoomId}`), updates);
  } catch (error) {
    console.error("돌 배치 에러:", error);
    showToast("데이터를 동기화하는 데 실패했습니다.");
  }
}

// 4목 판정 알고리즘
function checkConnect4(stones, lastX, lastY, playerId) {
  const directions = [
    [1, 0],   // 가로
    [0, 1],   // 세로
    [1, 1],   // 우하향 대각선 (\ 방향)
    [1, -1]   // 우상향 대각선 (/ 방향)
  ];

  for (const [dx, dy] of directions) {
    let count = 1;
    
    // 정방향 탐색
    let tx = lastX + dx;
    let ty = lastY + dy;
    while (tx >= -5 && tx <= 5 && ty >= -5 && ty <= 5) {
      if (stones[`${tx}_${ty}`]?.playerId === playerId) {
        count++;
        tx += dx;
        ty += dy;
      } else {
        break;
      }
    }

    // 역방향 탐색
    tx = lastX - dx;
    ty = lastY - dy;
    while (tx >= -5 && tx <= 5 && ty >= -5 && ty <= 5) {
      if (stones[`${tx}_${ty}`]?.playerId === playerId) {
        count++;
        tx -= dx;
        ty -= dy;
      } else {
        break;
      }
    }

    if (count >= 4) return true;
  }
  return false;
}

// 승리하게 만든 4개의 돌 좌표 키배열 반환
function getWinningLine(stones, lastX, lastY, playerId) {
  const directions = [
    [1, 0],   // 가로
    [0, 1],   // 세로
    [1, 1],   // 우하향 대각선
    [1, -1]   // 우상향 대각선
  ];

  for (const [dx, dy] of directions) {
    let line = [`${lastX}_${lastY}`];
    
    // 정방향
    let tx = lastX + dx;
    let ty = lastY + dy;
    while (tx >= -5 && tx <= 5 && ty >= -5 && ty <= 5) {
      if (stones[`${tx}_${ty}`]?.playerId === playerId) {
        line.push(`${tx}_${ty}`);
        tx += dx;
        ty += dy;
      } else {
        break;
      }
    }

    // 역방향
    tx = lastX - dx;
    ty = lastY - dy;
    while (tx >= -5 && tx <= 5 && ty >= -5 && ty <= 5) {
      if (stones[`${tx}_${ty}`]?.playerId === playerId) {
        line.push(`${tx}_${ty}`);
        tx -= dx;
        ty -= dy;
      } else {
        break;
      }
    }

    if (line.length >= 4) {
      // 정확히 4개(또는 그 이상) 연속된 경우의 코드를 정렬해 리턴
      return line.slice(0, 4);
    }
  }
  return [`${lastX}_${lastY}`]; // 폴백
}

// ==========================================
// 10. 오답 대응 & Gemini AI 힌트 연동
// ==========================================
async function handleWrongAnswer(target, input) {
  // 1. 로컬에 오답 로그 누적
  // [Session_ID, 클릭한_목표좌표, 입력한_오답좌표, 힌트_호출_여부, 타임스탬프]
  // 힌트 호출 여부는 Rate Limit 제한에 안 걸려서 API를 호출했을 때 true로 설정됨
  const logs = JSON.parse(localStorage.getItem('wood_connect4_analytics') || '[]');
  
  // Rate Limit 체크
  const canCallAi = checkRateLimit();
  
  const logEntry = {
    sessionId: sessionId,
    target: `${target.x},${target.y}`,
    input: `${input.x},${input.y}`,
    hintCalled: canCallAi,
    timestamp: Date.now()
  };
  
  logs.push(logEntry);
  localStorage.setItem('wood_connect4_analytics', JSON.stringify(logs));

  // 유저 채팅 로그 추가
  addUserChatMessage(`선택한 위치를 (${input.x}, ${input.y}) 라고 입력했어요.`);

  let hintText = "";

  if (canCallAi) {
    // Gemini AI 현자 힌트 호출
    addSystemChatMessage("🍃 숲속의 현자가 지혜를 모으는 중입니다...");
    hintText = await fetchGeminiSageHint(target, input);
  } else {
    // Rate Limit 초과 시 로컬 폴백 힌트 제공
    addSystemChatMessage("🍃 현자가 명상에 들어갔습니다. (API 호출 한도 초과)");
    hintText = getLocalFallbackHint(target, input);
  }

  // 현자 힌트 출력
  addSageChatMessage(hintText);
}

// Gemini API 비계(Scaffolding) 힌트 호출
async function fetchGeminiSageHint(target, input) {
  const apiKey = CONFIG.GEMINI_API_KEY;
  if (!apiKey || apiKey === "YOUR_GEMINI_API_KEY") {
    console.warn("Gemini API Key가 비어 있습니다. 로컬 힌트를 사용합니다.");
    return getLocalFallbackHint(target, input);
  }

  // 1분간 요청 횟수 기록
  geminiRequestTimestamps.push(Date.now());

  // 비계(Scaffolding) 교육용 프롬프트 설계
  // 중1 눈높이에 맞춰 부호와 축의 개념을 스스로 찾아가도록 설계
  const systemInstruction = `
너는 좌표평면 수학을 가르쳐주는 친절하고 따뜻한 "숲속의 현자(🧙‍♂️)" 역할을 맡은 AI 튜터이다.
대상은 중학교 1학년 학생이며, 좌표평면 위의 눈금을 클릭하고 이를 순서쌍 (x, y)로 적는 게임을 하고 있다.
학생이 목표 좌표와 다른 오답 좌표를 입력했을 때, 정답을 직접적으로 가르쳐주지 말고 (예: "정답은 (3,-2)야" 라고 하지 말 것),
학생이 왜 틀렸는지 오류 원인을 분석하여 스스로 깨달을 수 있도록 돕는 교육적 비계(Scaffolding)식 질문과 힌트를 제공하라.

[분석해야 할 오답 오류 패턴]
1. x축, y축 좌표 반전 (축 반전): x와 y 좌표가 정반대로 적힌 경우. (예: 목표 (3, -2)인데 (-2, 3) 입력)
2. 부호 오류: x나 y 중 한쪽 또는 둘 다 부호가 틀린 경우. (예: 목표 (-3, 2)인데 (3, 2) 또는 (-3, -2) 입력)
3. 원점 또는 축 위의 점 헷갈림: x=0 또는 y=0인 지점에서 좌표를 바꾸어 쓴 경우.
4. 단순 오기입: 단순 실수.

[힌트 가이드라인]
- 친근하고 인자한 말투 (해요체 "~란다", "~해보겠니?")를 사용하라.
- 먼저 학생의 시도를 칭찬하며 다독여 주어라.
- 좌표평면의 특성(가로축이 x축, 세로축이 y축이며, 순서쌍은 항상 가로 거리가 먼저, 세로 거리가 다음이라는 규칙)과 사분면의 부호(+ 또는 -)를 바탕으로 힌트를 주어라.
- 학생이 입력한 오답과 클릭한 목표점을 구체적으로 비교해 주어라.
- 2~3문장 이내로 명확하고 짧게 답변하라.
`;

  const prompt = `
[게임 상황 정보]
- 학생이 클릭한 목표 지점(좌표평면 실제 위치): (${target.x}, ${target.y})
- 학생이 입력창에 적어 제출한 오답 순서쌍: (${input.x}, ${input.y})

위 정보에 대해 분석하고, 학생에게 제공할 맞춤형 힌트를 한글로 작성해 주세요.
`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemInstruction + "\n\n" + prompt }] }
        ],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 250
        }
      })
    });

    if (!response.ok) {
      throw new Error(`API response status: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.error("Gemini API 호출 에러:", error);
    return getLocalFallbackHint(target, input);
  }
}

// 클라이언트 측 Rate Limit 검증 (분당 10회)
function checkRateLimit() {
  const now = Date.now();
  // 1분 이상 지난 타임스탬프 필터링
  geminiRequestTimestamps = geminiRequestTimestamps.filter(t => now - t < rateLimitWindowMs);
  
  if (geminiRequestTimestamps.length >= maxRequestsPerWindow) {
    return false; // 제한 초과
  }
  return true;
}

// 로컬 알고리즘 기반 비계 힌트 (API Key가 없거나 Rate limit 초과 시 폴백)
function getLocalFallbackHint(target, input) {
  let feedback = "허허, 길을 잃은 모양이구나. ";

  const isSwapped = (target.x === input.y && target.y === input.x);
  const isXSignWrong = (target.x === -input.x && target.y === input.y);
  const isYSignWrong = (target.x === input.x && target.y === -input.y);
  const isBothSignWrong = (target.x === -input.x && target.y === -input.y);

  if (isSwapped) {
    feedback += "가로축(x축)의 좌표와 세로축(y축)의 좌표가 서로 바뀐 것은 아닌지 확인해보렴. 순서쌍 (x, y)에서 첫 번째는 항상 가로 눈금이란다.";
  } else if (isBothSignWrong) {
    feedback += "X좌표와 Y좌표의 부호(+/-)가 정반대로 적혔구나. 네가 클릭한 사분면이 몇 사분면인지, 부호 특징을 떠올려보렴.";
  } else if (isXSignWrong) {
    feedback += `가로(X축) 방향의 부호가 헷갈린 것 같구나. 원점에서 오른쪽은 양수(+), 왼쪽은 음수(-)란다. 다시 확인해보겠니?`;
  } else if (isYSignWrong) {
    feedback += `세로(Y축) 방향의 부호가 잘못되었단다. 원점에서 위쪽은 양수(+), 아래쪽은 음수(-)라는 점을 기억하렴.`;
  } else if (target.x === 0 && input.x !== 0) {
    feedback += "원점 위 또는 Y축 위의 점이구나. Y축 위에 있는 점은 가로(X) 방향으로 움직이지 않았으니 X좌표가 0이어야 한단다.";
  } else if (target.y === 0 && input.y !== 0) {
    feedback += "원점 위 또는 X축 위의 점이구나. X축 위에 있는 점은 세로(Y) 방향으로 움직이지 않았으니 Y좌표가 0이란다.";
  } else {
    feedback += `네가 클릭한 점은 원점으로부터 가로로 ${target.x > 0 ? '오른쪽' : '왼쪽'}으로 ${Math.abs(target.x)}만큼, 세로로 ${target.y > 0 ? '위쪽' : '아래쪽'}으로 ${Math.abs(target.y)}만큼 떨어져 있단다. 이 눈금들을 순서대로 적어보렴.`;
  }
  
  return feedback;
}

// ==========================================
// 11. 데이터 분석 및 Firestore 일괄 쓰기(Batch Write)
// ==========================================
async function batchWriteAnalyticsToFirestore() {
  if (!isFirebaseConfigured || !fs) return;

  const logs = JSON.parse(localStorage.getItem('wood_connect4_analytics') || '[]');
  if (logs.length === 0) return;

  console.log(`Firestore에 ${logs.length}건의 오답 통계 데이터를 전송합니다 (Batch Write).`);

  try {
    const batch = writeBatch(fs);
    const analyticsCol = collection(fs, 'learning_analytics');

    logs.forEach(log => {
      // 고유 ID를 가지는 문서 참조 생성
      const newDocRef = doc(analyticsCol);
      batch.set(newDocRef, {
        ...log,
        roomId: currentRoomId,
        uploadedAt: Date.now()
      });
    });

    await batch.commit();
    console.log("Firestore 일괄 저장 성공!");
    
    // 전송 완료 후 로컬 캐시 비우기
    localStorage.removeItem('wood_connect4_analytics');
  } catch (error) {
    console.error("Firestore 일괄 저장 실패:", error);
  }
}

// ==========================================
// 12. 교사용 통계 대시보드
// ==========================================
function openDashboard() {
  teacherDashboardModal.classList.add('active');
  // 초기 접근 시 인증 번호 창 활성화
  teacherAuthSection.classList.remove('hidden');
  teacherStatsSection.classList.add('hidden');
  teacherPasswordInput.value = "";
  authErrorMsg.classList.add('hidden');
}

function closeDashboard() {
  teacherDashboardModal.classList.remove('active');
}

function handleTeacherAuth() {
  const password = teacherPasswordInput.value;
  // 기본 인증번호: 1234
  if (password === "1234") {
    teacherAuthSection.classList.add('hidden');
    teacherStatsSection.classList.remove('hidden');
    loadAndRenderTeacherStats();
  } else {
    authErrorMsg.classList.remove('hidden');
  }
}

// Firestore 데이터 로드 및 차트 그리기
async function loadAndRenderTeacherStats() {
  if (!isFirebaseConfigured || !fs) {
    // 오프라인 모드일 때 로컬에 저장된 로그 기반 시뮬레이션
    const logs = JSON.parse(localStorage.getItem('wood_connect4_analytics') || '[]');
    processAndRenderStats(logs);
    return;
  }

  try {
    const querySnapshot = await getDocs(collection(fs, 'learning_analytics'));
    const logs = [];
    querySnapshot.forEach(doc => {
      logs.push(doc.data());
    });
    processAndRenderStats(logs);
  } catch (error) {
    console.error("대시보드 통계 로드 에러:", error);
    showToast("Firestore 데이터를 불러오는 데 실패했습니다.");
  }
}

// 데이터를 바탕으로 차트 및 지표 렌더링
function processAndRenderStats(logs) {
  statTotalErrors.textContent = logs.length;

  if (logs.length === 0) {
    statAiRatio.textContent = "0%";
    statWorstQuadrant.textContent = "-";
    errorLogsTbody.innerHTML = `<tr><td colspan="6" class="no-data">오답 데이터 분석 중입니다...</td></tr>`;
    destroyCharts();
    return;
  }

  // 통계 계산
  let aiCalledCount = 0;
  const quadrantCounts = {
    "제1사분면": 0,
    "제2사분면": 0,
    "제3사분면": 0,
    "제4사분면": 0,
    "축/원점 위": 0
  };

  const logsList = [...logs].sort((a, b) => b.timestamp - a.timestamp); // 최근 시간순

  logsList.forEach(log => {
    if (log.hintCalled) aiCalledCount++;
    
    // target 좌표 기준 사분면 판정
    const [tx, ty] = log.target.split(',').map(Number);
    if (tx === 0 || ty === 0) {
      quadrantCounts["축/원점 위"]++;
    } else if (tx > 0 && ty > 0) {
      quadrantCounts["제1사분면"]++;
    } else if (tx < 0 && ty > 0) {
      quadrantCounts["제2사분면"]++;
    } else if (tx < 0 && ty < 0) {
      quadrantCounts["제3사분면"]++;
    } else if (tx > 0 && ty < 0) {
      quadrantCounts["제4사분면"]++;
    }
  });

  // AI 힌트 비율
  const aiRatio = Math.round((aiCalledCount / logs.length) * 100);
  statAiRatio.textContent = `${aiRatio}%`;

  // 최다 취약 사분면 산출
  let maxConfusedQuadrant = "-";
  let maxCount = -1;
  Object.keys(quadrantCounts).forEach(quad => {
    if (quadrantCounts[quad] > maxCount) {
      maxCount = quadrantCounts[quad];
      maxConfusedQuadrant = quad;
    }
  });
  statWorstQuadrant.textContent = maxConfusedQuadrant;

  // 차트 렌더링
  renderQuadrantChart(quadrantCounts);
  renderHintUsageChart(aiCalledCount, logs.length - aiCalledCount);

  // 테이블 렌더링
  errorLogsTbody.innerHTML = "";
  
  // 최근 50건 표시
  const recentLogs = logsList.slice(0, 50);
  recentLogs.forEach(log => {
    const dateStr = new Date(log.timestamp).toLocaleTimeString();
    
    // 오답 유형 분석
    const [tx, ty] = log.target.split(',').map(Number);
    const [ix, iy] = log.input.split(',').map(Number);
    let errorType = "단순 기입 오류";

    if (tx === iy && ty === ix) errorType = "x-y 축 뒤바꿈";
    else if (tx === -ix && ty === iy) errorType = "X부호 오류";
    else if (tx === ix && ty === -iy) errorType = "Y부호 오류";
    else if (tx === -ix && ty === -iy) errorType = "X, Y부호 모두 오류";

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td><span style="font-family:var(--font-english); font-size:0.75rem; color:#888;">${log.sessionId.substring(0, 8)}...</span></td>
      <td style="font-family:var(--font-english); font-weight:bold; color:var(--forest-mid)">(${log.target})</td>
      <td style="font-family:var(--font-english); font-weight:bold; color:var(--danger)">(${log.input})</td>
      <td><span style="background:rgba(0,0,0,0.05); padding:2px 8px; border-radius:4px;">${errorType}</span></td>
      <td>${log.hintCalled ? '<span style="color:var(--forest-light); font-weight:bold;">호출됨</span>' : '안 함'}</td>
    `;
    errorLogsTbody.appendChild(tr);
  });
}

function destroyCharts() {
  if (quadrantChart) quadrantChart.destroy();
  if (hintUsageChart) hintUsageChart.destroy();
}

function renderQuadrantChart(quadCounts) {
  const ctx = document.getElementById('quadrant-chart').getContext('2d');
  
  if (quadrantChart) quadrantChart.destroy();

  quadrantChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(quadCounts),
      datasets: [{
        label: '오답 발생 수',
        data: Object.values(quadCounts),
        backgroundColor: [
          'rgba(242, 201, 76, 0.75)', // 1사분면
          'rgba(76, 140, 74, 0.75)',  // 2사분면
          'rgba(92, 58, 33, 0.75)',   // 3사분면
          'rgba(235, 87, 87, 0.75)',  // 4사분면
          'rgba(142, 179, 130, 0.75)' // 축/원점
        ],
        borderColor: [
          '#f2c94c', '#4c8c4a', '#5c3a21', '#eb5757', '#8eb382'
        ],
        borderWidth: 1.5,
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 }
        }
      }
    }
  });
}

function renderHintUsageChart(called, notCalled) {
  const ctx = document.getElementById('hint-usage-chart').getContext('2d');

  if (hintUsageChart) hintUsageChart.destroy();

  hintUsageChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['AI 힌트 호출', '일반 진행'],
      datasets: [{
        data: [called, notCalled],
        backgroundColor: ['rgba(76, 140, 74, 0.8)', 'rgba(0, 0, 0, 0.1)'],
        borderColor: ['#4c8c4a', 'rgba(0, 0, 0, 0.15)'],
        borderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom'
        }
      }
    }
  });
}

// ==========================================
// 13. 채팅창 도우미 함수
// ==========================================
function addUserChatMessage(msg) {
  const msgDiv = document.createElement('div');
  msgDiv.className = "chat-message user";
  msgDiv.innerHTML = `<p>${escapeHtml(msg)}</p>`;
  sageChatHistory.appendChild(msgDiv);
  scrollChatToBottom();
}

function addSageChatMessage(msg) {
  const msgDiv = document.createElement('div');
  msgDiv.className = "chat-message sage";
  msgDiv.innerHTML = `<p>${escapeHtml(msg)}</p>`;
  sageChatHistory.appendChild(msgDiv);
  scrollChatToBottom();
}

function addSystemChatMessage(msg) {
  const msgDiv = document.createElement('div');
  msgDiv.className = "chat-message system";
  msgDiv.innerHTML = `<p>${escapeHtml(msg)}</p>`;
  sageChatHistory.appendChild(msgDiv);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  sageChatHistory.scrollTop = sageChatHistory.scrollHeight;
}

// ==========================================
// 14. 유틸리티 함수군
// ==========================================
function validateName() {
  const name = playerNameInput.value.trim();
  if (name.length === 0) {
    showToast("닉네임을 입력해주세요!");
    playerNameInput.focus();
    return false;
  }
  myName = name;
  localStorage.setItem('wood_connect4_player_name', name);
  return true;
}

function checkFirebaseConnection() {
  if (!isFirebaseConfigured) {
    showToast("⚠️ Firebase 설정 정보가 제공되지 않아, 현재 로컬 가상 플레이 모드입니다.");
    return false;
  }
  return true;
}

function copyRoomCode() {
  if (!currentRoomId) return;
  navigator.clipboard.writeText(currentRoomId).then(() => {
    showToast("방 코드가 클립보드에 복사되었습니다!");
  }).catch(err => {
    console.error("클립보드 복사 실패:", err);
    showToast(`방 코드: ${currentRoomId}`);
  });
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateUUID() {
  return 'player_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
}

function showToast(msg) {
  toastMessage.textContent = msg;
  toastMessage.classList.remove('hidden');
  
  // 기존 타이머 클리어 후 3초 뒤 숨김
  if (window.toastTimer) clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => {
    toastMessage.classList.add('hidden');
  }, 3000);
}

// Lodash style Debounce
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    const later = function() {
      timeout = null;
      func.apply(context, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// HTML 이스케이프
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

// ==========================================
// 15. 로컬 봇 AI 행동 로직 (오프라인 모드)
// ==========================================
function handleBotTurn() {
  if (!isLocalMode || roomState.status !== "playing") return;

  const botPlayerId = "bot_squirrel";
  const stones = roomState.stones || {};
  const lastMove = roomState.lastMove;
  
  // 1. 후보 교차점(valid moves) 탐색
  const candidates = [];
  
  if (!lastMove) {
    // 첫 수라면 판 중앙 근처에 랜덤하게 놓음
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (!stones[`${x}_${y}`]) {
          candidates.push({ x, y });
        }
      }
    }
  } else {
    // 이전 수의 x좌표 고정하고 y만 변경
    for (let y = -5; y <= 5; y++) {
      if (y !== lastMove.y && !stones[`${lastMove.x}_${y}`]) {
        candidates.push({ x: lastMove.x, y });
      }
    }
    // 이전 수의 y좌표 고정하고 x만 변경
    for (let x = -5; x <= 5; x++) {
      if (x !== lastMove.x && !stones[`${x}_${lastMove.y}`]) {
        candidates.push({ x, y: lastMove.y });
      }
    }
  }

  // 둘 수 있는 곳이 아예 없으면 무승부 처리 또는 종료
  if (candidates.length === 0) {
    roomState.status = "finished";
    roomState.winner = null;
    renderGameUI(roomState);
    addSystemChatMessage("🍃 더 이상 둘 곳이 없군요. 무승부입니다!");
    showToast("게임 종료! 무승부입니다.");
    return;
  }

  let selectedMove = null;

  // AI 의사결정: 1단계 - 봇이 당장 이길 수 있는 자리가 있는지 (공격)
  for (const mv of candidates) {
    const tempStones = { ...stones, [`${mv.x}_${mv.y}`]: { playerId: botPlayerId } };
    if (checkConnect4(tempStones, mv.x, mv.y, botPlayerId)) {
      selectedMove = mv;
      break;
    }
  }

  // AI 의사결정: 2단계 - 플레이어가 다음 턴에 이길 수 있어서 방어해야 하는 자리가 있는지 (수비)
  if (!selectedMove) {
    for (const mv of candidates) {
      const tempStones = { ...stones, [`${mv.x}_${mv.y}`]: { playerId: myPlayerId } };
      if (checkConnect4(tempStones, mv.x, mv.y, myPlayerId)) {
        selectedMove = mv;
        break;
      }
    }
  }

  // AI 의사결정: 3단계 - 그냥 랜덤 선택
  if (!selectedMove) {
    selectedMove = candidates[Math.floor(Math.random() * candidates.length)];
  }

  // 봇의 수 적용
  const botKey = `${selectedMove.x}_${selectedMove.y}`;
  stones[botKey] = {
    playerId: botPlayerId,
    timestamp: Date.now()
  };

  const nextMove = {
    x: selectedMove.x,
    y: selectedMove.y,
    playerId: botPlayerId,
    emoji: playerDesigns[1].emoji
  };

  const hasWon = checkConnect4(stones, selectedMove.x, selectedMove.y, botPlayerId);
  const updatedStatus = hasWon ? "finished" : "playing";
  const winner = hasWon ? botPlayerId : null;

  roomState.stones = stones;
  roomState.lastMove = nextMove;
  roomState.currentTurnIndex = 0; // 다시 내 턴으로
  roomState.status = updatedStatus;
  roomState.winner = winner;

  if (hasWon) {
    const winStones = getWinningLine(stones, selectedMove.x, selectedMove.y, botPlayerId);
    roomState.winningStones = winStones;
  }

  renderGameUI(roomState);
  
  // 봇이 둔 수에 대해 안내
  addSystemChatMessage(`🐿️ 다람쥐 봇이 (${selectedMove.x}, ${selectedMove.y})에 돌을 놓았습니다.`);
  addSageChatMessage(`"다람쥐 봇이 (${selectedMove.x}, ${selectedMove.y})에 돌을 놓았구나. 다음은 네 차례란다."`);

  if (hasWon) {
    addSystemChatMessage("🏆 승리자: 다람쥐 봇! 다음 기회에 도전하세요.");
    showToast("게임 종료! 다람쥐 봇이 승리했습니다.");
    highlightWinningStones(roomState.winningStones);
    batchWriteAnalyticsToFirestore();
  }
}

