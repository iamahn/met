
// =========================================================================
// 1. 글로벌 데이터 상태 정의 (7개 채널의 상태를 독립적으로 보관)
// =========================================================================
const TOTAL_CHANNELS = 7;
const CHANNELS_DATA = [];

// 오디오 재생을 위한 웹 오디오 컨텍스트 및 버퍼 저장소
let audioCtx = null;
const audioBuffers = {};

// 타이밍 엔진 변수들
let isPlaying = false;
let timeoutId = null;
let currentBeat = 0; // 0 ~ 95까지 증가하는 초미세 tick 카운터 (각 음표들의 최소공배수 처리용)
let nextNoteTime = 0.0;
const lookahead = 25.0; // 스케줄러 호출 주기 (ms)
const scheduleAheadTime = 0.1; // 미리 큐에 담아둘 시간 범위 (sec)

// UI 요소 셀렉터들
const circleContainers = document.querySelectorAll('.circle-container');
const gridCellsLine1 = document.querySelectorAll('.grid-line:nth-child(1) .grid-cell'); // 32분음표 라인
const gridCellsLine2 = document.querySelectorAll('.grid-line:nth-child(2) .grid-cell'); // 6연음 라인
const gridCellsLine3 = document.querySelectorAll('.grid-line:nth-child(3) .grid-cell'); // 16분음표 라인

// 상단 설정 박스 파싱
const tempo = parseInt(document.querySelector('.rect-box.large').textContent) || 60;

// 현재 유저가 보고 있는 활성화된 채널 번호 (0 ~ 6)
let activeChannelIndex = 0;

// 데이터 구조 초기화
function initData() {
    for (let i = 0; i < TOTAL_CHANNELS; i++) {
        CHANNELS_DATA.push({
            id: i,
            sound: circleContainers[i].querySelector('.dropdown-menu').value,
            volume: parseInt(circleContainers[i].querySelector('.volume-slider').value) / 100,
            // 패턴 상태 저장: 0 = 무음, 1 = 일반(오렌지), 2 = 엑센트(빨강)
            pattern: {
                line32: new Array(32).fill(0),
                line6: new Array(24).fill(0),
                line16: new Array(16).fill(0)
            }
        });
    }
}

// =========================================================================
// 2. 오디오 컨텍스트 및 사운드 버퍼 로더
// =========================================================================
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function loadSound(soundName) {
    if (audioBuffers[soundName]) return; // 이미 불러온 사운드는 패스
    
    const filePath = `./sound/${soundName}.wav`;
    try {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        audioBuffers[soundName] = audioBuffer;
    } catch (err) {
        console.warn(`사운드 로드 실패 (${soundName}): 데이터가 없으므로 가상 오실레이터 비프로 대체됩니다.`, err);
    }
}

// 오디오 재생 처리 로직
function playSample(soundName, time, volume, isAccent) {
    if (!audioCtx) return;
    
    // 오렌지색 대비 빨간색(Accent)일 때 볼륨 가중치 부여
    const finalVolume = isAccent ? Math.min(volume * 1.5, 1.2) : volume;
    
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(finalVolume, time);
    gainNode.connect(audioCtx.destination);

    if (audioBuffers[soundName]) {
        // 실제 파일 재생
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffers[soundName];
        source.connect(gainNode);
        source.start(time);
    } else {
        // 파일 로드 실패 혹은 로컬 개발 환경용 가상 비프음 발생기
        const osc = audioCtx.createOscillator();
        osc.type = isAccent ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(isAccent ? 180 : 120, time);
        osc.connect(gainNode);
        osc.start(time);
        osc.stop(time + 0.1);
    }
}

// =========================================================================
// 3. UI 렌더링 및 동기화 (레이어/종이 전환 시스템)
// =========================================================================

// 선택된 서클 패드 활성화 시각 효과 부여 및 데이터 시트 새로고침
function selectChannel(index) {
    activeChannelIndex = index;
    
    circleContainers.forEach((container, idx) => {
        const circle = container.querySelector('.circle-box');
        if (idx === index) {
            circle.style.backgroundColor = '#4a90e2'; // 현재 보고 있는 종이(활성화 서클) 푸른빛 강조
            circle.style.border = '3px solid #333';
        } else {
            circle.style.backgroundColor = '#999999';
            circle.style.border = 'none';
        }
    });

    // 해당 종이의 데이터로 하단 그리드 상자 상태 전면 리렌더링
    const data = CHANNELS_DATA[activeChannelIndex].pattern;
    renderLineUI(gridCellsLine1, data.line32);
    renderLineUI(gridCellsLine2, data.line6);
    renderLineUI(gridCellsLine3, data.line16);
}

function renderLineUI(domCells, dataArray) {
    domCells.forEach((cell, idx) => {
        const state = dataArray[idx];
        if (state === 0) {
            cell.style.backgroundColor = '#b3b3b3'; // 기본 회색
        } else if (state === 1) {
            cell.style.backgroundColor = '#ffa500'; // 오렌지색
        } else if (state === 2) {
            cell.style.backgroundColor = '#ff4d4d'; // 빨간색 (Accent)
        }
    });
}

// =========================================================================
// 4. 타이밍 룰 및 스케줄러 알고리즘
// =========================================================================

// 4박 기준의 루프를 위해 각 음표들이 정확히 매칭되도록 96분음표 단위 베이스 틱 연산
// 32분음표는 3틱마다, 6연음(24개)은 4틱마다, 16분음표는 6틱마다 트리거됩니다.
function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
        scheduleNextNotes(currentBeat, nextNoteTime);
        advanceBeat();
    }
    timeoutId = setTimeout(scheduler, lookahead);
}

function advanceBeat() {
    // 1분당 사분음표 기준 템포 계산 ➔ 96분음표 단위로 쪼개기
    const secondsPerBeat = 60.0 / tempo;
    const secondsPerTick = secondsPerBeat / 24; // 사분음표 1개를 24틱으로 쪼갬 (24 * 4박 = 96틱)
    
    nextNoteTime += secondsPerTick;
    currentBeat = (currentBeat + 1) % 96; // 4박 동기화 루프 커서
}

function scheduleNextNotes(tick, time) {
    // 7개의 모든 레이어(종이) 데이터를 동시에 실시간으로 순회 검사 (최대 7음 동시 출력 루프)
    CHANNELS_DATA.forEach(channel => {
        // 32분음표 검사 (96틱 기준 3틱마다 마디 분할)
        if (tick % 3 === 0) {
            const step32 = tick / 3;
            const state = channel.pattern.line32[step32];
            if (state > 0) playSample(channel.sound, time, channel.volume, state === 2);
        }
        
        // 6연음 검사 (96틱 기준 4틱마다 마디 분할)
        if (tick % 4 === 0) {
            const step6 = tick / 4;
            const state = channel.pattern.line6[step6];
            if (state > 0) playSample(channel.sound, time, channel.volume, state === 2);
        }
        
        // 16분음표 검사 (96틱 기준 6틱마다 마디 분할)
        if (tick % 6 === 0) {
            const step16 = tick / 6;
            const state = channel.pattern.line16[step16];
            if (state > 0) playSample(channel.sound, time, channel.volume, state === 2);
        }
    });
}

// 드럼머신 시작/정지 토글 함수
function togglePlayback() {
    initAudio();
    if (!isPlaying) {
        isPlaying = true;
        currentBeat = 0;
        nextNoteTime = audioCtx.currentTime + 0.05;
        scheduler();
        console.log("드럼머신이 재생됩니다. (템포: " + tempo + ")");
    } else {
        isPlaying = false;
        clearTimeout(timeoutId);
        console.log("드럼머신이 일시 정지되었습니다.");
    }
}

// =========================================================================
// 5. 이벤트 리스너 바인딩 (인터랙션 핸들러)
// =========================================================================
function setupEventListeners() {
    // A. 7개 원형 상자(종이 시트 교체) 선택 이벤트 등록
    circleContainers.forEach((container, index) => {
        const circle = container.querySelector('.circle-box');
        circle.addEventListener('click', () => {
            initAudio();
            selectChannel(index);
        });

        // 드롭다운 변경 시 즉시 오디오 캐싱 및 악기 데이터 업데이트
        const select = container.querySelector('.dropdown-menu');
        select.addEventListener('change', (e) => {
            initAudio();
            CHANNELS_DATA[index].sound = e.target.value;
            loadSound(e.target.value);
        });

        // 슬라이더 변경 시 각 트랙 볼륨 실시간 갱신
        const slider = container.querySelector('.volume-slider');
        slider.addEventListener('input', (e) => {
            CHANNELS_DATA[index].volume = parseInt(e.target.value) / 100;
        });
    });

    // B. 하단 그리드 클릭 시 3단계 상태 토글 이벤트 핸들러 (0:회색 -> 1:오렌지 -> 2:빨강 -> 0:회색)
    function bindLineClickEvents(domCells, arrayKey) {
        domCells.forEach((cell, idx) => {
            cell.addEventListener('click', () => {
                initAudio();
                const currentPatternData = CHANNELS_DATA[activeChannelIndex].pattern[arrayKey];
                
                // 순환식 상태 토글 로직
                let nextState = (currentPatternData[idx] + 1) % 3;
                currentPatternData[idx] = nextState;
                
                // UI 즉시 업데이트
                if (nextState === 0) {
                    cell.style.backgroundColor = '#b3b3b3';
                } else if (nextState === 1) {
                    cell.style.backgroundColor = '#ffa500'; // 일반 입력 (오렌지)
                } else if (nextState === 2) {
                    cell.style.backgroundColor = '#ff4d4d'; // 엑센트 (빨강)
                }
            });
        });
    }

    bindLineClickEvents(gridCellsLine1, 'line32');
    bindLineClickEvents(gridCellsLine2, 'line6');
    bindLineClickEvents(gridCellsLine3, 'line16');

    // C. 상단 Tempo 및 패널 영역을 클릭 시 드럼머신 시작/멈춤 연동
    document.querySelector('.rect-box.large').style.cursor = 'pointer';
    document.querySelector('.rect-box.large').addEventListener('click', togglePlayback);
}

// =========================================================================
// 6. 애플리케이션 초기 구동 시점
// =========================================================================
window.addEventListener('DOMContentLoaded', () => {
    initData();
    setupEventListeners();
    selectChannel(0); // 첫 구동 시 1번째 종이 레이어 노출
    
    // 초기 사운드 선행 다운로드 로드 시도
    CHANNELS_DATA.forEach(channel => {
        if(audioCtx) loadSound(channel.sound);
    });
});
