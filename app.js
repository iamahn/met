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


// 초기 로드 시 tick 사운드도 미리 로드 목록에 추가해 줍니다.
window.addEventListener('DOMContentLoaded', () => {
    initData();
    setupEventListeners();
    selectChannel(0);
    updateTempoDisplay(tempo); 
    updateTimeSignatureUI();
    
    // 💡 [추가] 공통 tick 사운드 사전 로드 선언
    if (audioCtx) {
        loadSound('tick');
    }
});



// ⚡ 박자수(Time Signature) 설정 상태 (1/4 ~ 4/4) 및 최대 틱 제한
let timeSignature = 4; // 기본값 4/4
const btnSignature = document.getElementById('btn-signature');
if (btnSignature) {
    btnSignature.addEventListener('click', () => {
        // 1/4 ~ 4/4 순환 구조 (4 다음엔 다시 1로)
        timeSignature = timeSignature >= 4 ? 1 : timeSignature + 1;
        
        // 박자가 바뀔 때마다 전체 UI(그리드, 프로그레스바) 동기화 호출
        updateTimeSignatureUI(); 
    });
}


let maxTicks = 96;     // 박자수에 따른 최대 tick 제한 (1박당 24 tick * timeSignature)

let animationFrameId = null; 
const progressBar = document.getElementById('beat-progress-bar');
const circleContainers = document.querySelectorAll('.circle-container');

// progress-line을 제외하고 순수한 패턴 그리드 라인들만 차례대로 선택합니다.
const actualGridLines = document.querySelectorAll('.grid-line:not(.progress-line)');
const gridCellsLine1 = actualGridLines[0].querySelectorAll('.grid-cell'); // 32분음표 라인 (8개씩 4그룹)
const gridCellsLine2 = actualGridLines[1].querySelectorAll('.grid-cell'); // 6연음 라인 (6개씩 4그룹)
const gridCellsLine3 = actualGridLines[2].querySelectorAll('.grid-cell'); // 16분음표 라인 (4개씩 4그룹)

const tempoDisplay = document.getElementById('bpm-value');
let tempo = parseInt(tempoDisplay.textContent) || 60;

let activeChannelIndex = 0;

// Tap Tempo 측정을 위한 배열 기록 장치
let tapTimes = [];

// 연속 증감(Long-press) 처리를 위한 타이머 변수
let tempoIntervalId = null;
let tempoTimeoutId = null;

// 데이터 초기화
function initData() {
    for (let i = 0; i < TOTAL_CHANNELS; i++) {
        CHANNELS_DATA.push({
            id: i,
            sound: circleContainers[i].querySelector('.dropdown-menu').value,
            volume: parseInt(circleContainers[i].querySelector('.volume-slider').value) / 100,
            pattern: {
                line32: new Array(32).fill(0),
                line6: new Array(24).fill(0),
                line16: new Array(16).fill(0)
            }
        });
    }
}

// 템포 업데이트 시 화면 숫자 반영 함수
// 템포 업데이트 시 화면 숫자 반영 함수 (small 박스 연동 제거 버전)
function updateTempoDisplay(newTempo) {
    tempo = Math.max(30, Math.min(newTempo, 300));
    
    // medium 박스 안의 bpm-value 스팬 태그 변경
    const bpmValueDisplay = document.getElementById('bpm-value');
    if (bpmValueDisplay) {
        bpmValueDisplay.textContent = String(tempo).padStart(3, '0');
    }
}




// =========================================================================
// [기능 코어 구현 함수들]
// =========================================================================

// 1. CLEAR 기능: 현재 선택된 채널의 시트만 0으로 초기화
function clearActiveChannelPattern() {
    const currentPattern = CHANNELS_DATA[activeChannelIndex].pattern;
    currentPattern.line32.fill(0);
    currentPattern.line6.fill(0);
    currentPattern.line16.fill(0);
    
    // UI 그리드판 즉시 새로고침
    updateTimeSignatureUI();
    console.log(`${activeChannelIndex + 1}번째 트랙의 패턴 기록이 삭제되었습니다.`);
}

// 2. TAP TEMPO 엔진 연산
function handleTapTempo() {
    initAudio();
    const now = performance.now();
    tapTimes.push(now);

    if (tapTimes.length > 4) {
        tapTimes.shift();
    }

    if (tapTimes.length >= 2) {
        let totalIntervals = 0;
        for (let i = 1; i < tapTimes.length; i++) {
            totalIntervals += (tapTimes[i] - tapTimes[i - 1]);
        }
        const avgInterval = totalIntervals / (tapTimes.length - 1);
        const calculatedTempo = Math.round(60000 / avgInterval);
        
        updateTempoDisplay(calculatedTempo);
    }
    
    clearTimeout(window.tapResetTimeout);
    window.tapResetTimeout = setTimeout(() => { tapTimes = []; }, 3000);
}

// 3. 연속 증감(Long Press) 매커니즘 구현 함수
function startChangingTempo(amount) {
    updateTempoDisplay(tempo + amount);
    tempoTimeoutId = setTimeout(() => {
        tempoIntervalId = setInterval(() => {
            updateTempoDisplay(tempo + amount);
        }, 50);
    }, 400);
}

function stopChangingTempo() {
    clearTimeout(tempoTimeoutId);
    clearInterval(tempoIntervalId);
}

// ⚡ 4. 동적 박자 변경 (Time Signature) 연동 및 Grid 골드 처리 엔진
function updateTimeSignatureUI() {
    // 박자수에 따른 최대 틱 제한 수치 설정 (1박자당 24틱)
    maxTicks = timeSignature * 24;
    currentBeat = currentBeat % maxTicks;

    // 1) [수정] 이제 small 박스 내부의 박자 기호 갱신
    const sigValueDisplay = document.getElementById('sig-value');
    if (sigValueDisplay) {
        sigValueDisplay.textContent = `${timeSignature}/4`;
    }

    // 2) 그리드 라인 별 4개 그룹들의 활성화/비활성화(Gold 블렌딩) 처리
    actualGridLines.forEach((line, lineIdx) => {
        const groups = line.querySelectorAll('.grid-group');
        groups.forEach((group, gIdx) => {
            const isActive = gIdx < timeSignature;
            const cells = group.querySelectorAll('.grid-cell');
            
            if (isActive) {
                group.style.opacity = "1";
                cells.forEach((cell, cIdx) => {
                    cell.style.pointerEvents = 'auto';
                    cell.style.boxShadow = 'inset 0 1px 2px rgba(255, 255, 255, 0.2), 0 1px 2px rgba(0, 0, 0, 0.1)';
                    cell.style.border = '';
                    
                    const totalIndex = (gIdx * cells.length) + cIdx;
                    const currentPattern = CHANNELS_DATA[activeChannelIndex].pattern;
                    let stateVal = 0;
                    
                    if (lineIdx === 0) stateVal = currentPattern.line32[totalIndex];
                    else if (lineIdx === 1) stateVal = currentPattern.line6[totalIndex];
                    else if (lineIdx === 2) stateVal = currentPattern.line16[totalIndex];

                    if (stateVal === 0) cell.style.backgroundColor = 'darkkhaki';
                    else if (stateVal === 1) cell.style.backgroundColor = '#ffa500';
                    else if (stateVal === 2) cell.style.backgroundColor = '#ff4d4d';
                });
            } else {
                cells.forEach(cell => {
                    cell.style.pointerEvents = 'none';
                    cell.style.backgroundColor = 'gold';
                    cell.style.boxShadow = 'none';
                    cell.style.border = 'none';
                });
            }
        });
    });

    // 3) 프로그레스 바 컨테이너 너비 맞춤 (이전 최종 완성본 유지)
    const progressContainer = document.querySelector('.progress-bar-container');
    if (progressContainer) {
        const firstLineGroups = actualGridLines[0].querySelectorAll('.grid-group');
        let totalActiveWidth = 0;
        let activeCount = 0;

        firstLineGroups.forEach((group, gIdx) => {
            if (gIdx < timeSignature) {
                const rect = group.getBoundingClientRect();
                totalActiveWidth += rect.width;
                activeCount++;
            }
        });

        if (totalActiveWidth > 0) {
            const totalGap = (activeCount - 1) * 10; 
            const finalWidth = totalActiveWidth + totalGap;

            progressContainer.style.flex = "none"; 
            progressContainer.style.width = `${finalWidth}px`;
            progressContainer.style.maxWidth = `${finalWidth}px`;
        } else {
            progressContainer.style.flex = "1";
            progressContainer.style.width = "100%";
            progressContainer.style.maxWidth = "none";
        }
    }
}
// 박자수 클릭 순환 함수
function cycleTimeSignature() {
    timeSignature = (timeSignature % 4) + 1; // 1 -> 2 -> 3 -> 4 -> 1 순환
    updateTimeSignatureUI();
    console.log(`박자가 ${timeSignature}/4 로 변경되었습니다.`);
}

// =========================================================================
// 5. 오디오 컨텍스트 및 사운드 버퍼 로더
// =========================================================================
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function loadSound(soundName) {
    if (soundName === 'empty') return;
    
    // 🔥 [신규] human1, human2, human3 일 경우 4개의 음성 파일을 세트로 로드
    if (soundName.startsWith('human')) {
        const num = soundName.replace('human', ''); // '1', '2', '3' 추출
        const counts = ['one', 'two', 'three', 'four'];
        
        for (const count of counts) {
            const fileName = `${count}${num}`; // 예: 'one1', 'two1' ...
            if (audioBuffers[fileName]) continue; // 이미 로드되었다면 패스
            
            const filePath = `./sound/${fileName}.wav`;
            try {
                const response = await fetch(filePath);
                if (!response.ok) throw new Error(`파일 분실: ${filePath}`);
                const arrayBuffer = await response.arrayBuffer();
                audioBuffers[fileName] = await audioCtx.decodeAudioData(arrayBuffer);
            } catch (err) {
                console.warn(`${fileName}.wav 로드 실패. 기본 오실레이터로 대체됩니다.`, err);
            }
        }
        return;
    }

    // 기존 일반 악기(kick, snare 등) 로드 로직 유지
    if (audioBuffers[soundName]) return;
    const filePath = `./sound/${soundName}.wav`;
    try {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`파일 분실: ${filePath}`);
        const arrayBuffer = await response.arrayBuffer();
        audioBuffers[soundName] = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (err) {
        console.warn(`가상 오실레이터 비프로 대체됩니다.`, err);
    }
}

function playSample(soundName, time, volume, isAccent) {
    if (soundName === 'empty') return;
    if (!audioCtx) return;
    
    const finalVolume = isAccent ? Math.min(volume * 1.5, 1.2) : volume;
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(finalVolume, time);
    gainNode.connect(audioCtx.destination);

    if (audioBuffers[soundName]) {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffers[soundName];
        source.connect(gainNode);
        source.start(time);
    } else {
        const osc = audioCtx.createOscillator();
        osc.type = isAccent ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(isAccent ? 180 : 120, time);
        osc.connect(gainNode);
        osc.start(time);
        osc.stop(time + 0.1);
    }
}

// =========================================================================
// 6. UI 채널 선택 브릿지
// =========================================================================
function selectChannel(index) {
    activeChannelIndex = index;
    
    circleContainers.forEach((container, idx) => {
        const circle = container.querySelector('.circle-box');
        if (idx === index) {
            circle.classList.add('selected');
        } else {
            circle.classList.remove('selected');
        }
    });

    // 채널 전환 시 활성 상태에 맞춰 다시 UI를 렌더링
    updateTimeSignatureUI();
}

// =========================================================================
// 7. 타이밍 룰 및 스케줄러 알고리즘
// =========================================================================
function scheduler() {
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
        scheduleNextNotes(currentBeat, nextNoteTime);
        advanceBeat();
    }
    timeoutId = setTimeout(scheduler, lookahead);
}

function advanceBeat() {
    const secondsPerBeat = 60.0 / tempo;
    const secondsPerTick = secondsPerBeat / 24; 
    
    nextNoteTime += secondsPerTick;
    currentBeat = (currentBeat + 1) % maxTicks; // maxTicks 룰에 맞게 유동적 루프 렝스 처리
}

function scheduleNextNotes(tick, time) {
    if (tick % 24 === 0) {
        const tapBtn = document.getElementById('btn-tap');
        if (tapBtn) {
            tapBtn.classList.add('tap-blink');
            setTimeout(() => { tapBtn.classList.remove('tap-blink'); }, 150);
        }
    }   
    
    CHANNELS_DATA.forEach(channel => {
        let soundToPlay = channel.sound;
        
        // 💡 [Human 엔진 업그레이드]
        if (soundToPlay.startsWith('human')) {
            const num = soundToPlay.replace('human', ''); // '1', '2', '3' 추출
            
            // 1박자 = 24tick 입니다. 
            // tick % 24가 정확히 0일 때만 박자의 첫 시작(정박)입니다.
            const isExactBeat = (tick % 24 === 0); 
            
            if (isExactBeat) {
                // 정박일 때는 기존처럼 현재 박수(0, 1, 2, 3)를 구해서one, two, three, four 매칭
                const currentBeatIndex = Math.floor(tick / 24); 
                const counts = ['one', 'two', 'three', 'four'];
                const targetCount = counts[currentBeatIndex] || 'one';
                
                soundToPlay = `${targetCount}${num}`; // 예: 'one1', 'two1' ...
            } else {
                // 🔥 정박이 아닐 때 쪼개진 모든 박자는 공통 기계음 'tick'으로 강제 변환!
                soundToPlay = 'tick'; 
            }
        }

        // 32분음표 라인 (8 notes per beat)
        if (tick % 3 === 0) {
            const step32 = tick / 3;
            const state = channel.pattern.line32[step32];
            if (state > 0 && step32 < (timeSignature * 8)) {
                playSample(soundToPlay, time, channel.volume, state === 2);
            }
        }
        
        // 6연음 라인 (6 notes per beat)
        if (tick % 4 === 0) {
            const step6 = tick / 4;
            const state = channel.pattern.line6[step6];
            if (state > 0 && step6 < (timeSignature * 6)) {
                playSample(soundToPlay, time, channel.volume, state === 2);
            }
        }
        
        // 16분음표 라인 (4 notes per beat)
        if (tick % 6 === 0) {
            const step16 = tick / 6;
            const state = channel.pattern.line16[step16];
            if (state > 0 && step16 < (timeSignature * 4)) {
                playSample(soundToPlay, time, channel.volume, state === 2);
            }
        }
    });
}

function togglePlayback() {
    initAudio();
    if (!isPlaying) {
        isPlaying = true;
        currentBeat = 0;
        nextNoteTime = audioCtx.currentTime + 0.05;
        scheduler();
        
        function updateProgressBarLoop() {
            if (!isPlaying) return;
            
            const progressPercent = (currentBeat / maxTicks) * 100;
            if (progressBar) {
                progressBar.style.width = `${progressPercent}%`;
                progressBar.style.background = `repeating-linear-gradient(
                    90deg,
                    rgba(51, 255, 51, 0.5),
                    rgba(51, 255, 51, 0.5) 5px,
                    transparent 5px,
                    transparent 7px
                )`;
            }
            animationFrameId = requestAnimationFrame(updateProgressBarLoop);
        }
        animationFrameId = requestAnimationFrame(updateProgressBarLoop);
        console.log("드럼머신 재생 시작 (템포: " + tempo + ")");
    } else {
        isPlaying = false;
        clearTimeout(timeoutId);
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (progressBar) progressBar.style.width = '0%';
        console.log("드럼머신 일시 정지.");
    }
}

// =========================================================================
// 8. 이벤트 리스너 바인딩 (인터랙션 핸들러)
// =========================================================================
function setupEventListeners() {
    // ⚡ [수정 포인트] .rect-box.medium 박자 전환 클릭 리스너 바인딩

    circleContainers.forEach((container, index) => {
        const circle = container.querySelector('.circle-box');
        circle.addEventListener('click', () => {
            initAudio();
            selectChannel(index);
        });

        const select = container.querySelector('.dropdown-menu');
        select.addEventListener('change', (e) => {
            initAudio();
            CHANNELS_DATA[index].sound = e.target.value;
            loadSound(e.target.value);
        });

        const slider = container.querySelector('.volume-slider');
        slider.addEventListener('input', (e) => {
            CHANNELS_DATA[index].volume = parseInt(e.target.value) / 100;
        });
    });

    // 하단 그리드 클릭 시 3단계 상태 토글 이벤트 핸들러
    function bindLineClickEvents(domCells, arrayKey, lineIdx) {
        domCells.forEach((cell, idx) => {
            cell.addEventListener('click', () => {
                initAudio();
                
                // ⚡ 비활성화(골드 구역)된 버튼 클릭 시 연산 차단 방어코드
                const groupIdx = Math.floor(idx / (domCells.length / 4));
                if (groupIdx >= timeSignature) return;

                const currentPatternData = CHANNELS_DATA[activeChannelIndex].pattern[arrayKey];
                let nextState = (currentPatternData[idx] + 1) % 3;
                currentPatternData[idx] = nextState;
                
                if (nextState === 0) cell.style.backgroundColor = 'darkkhaki'; 
                else if (nextState === 1) cell.style.backgroundColor = '#ffa500'; 
                else if (nextState === 2) cell.style.backgroundColor = '#ff4d4d'; 
            });
        });
    }

    bindLineClickEvents(gridCellsLine1, 'line32', 0);
    bindLineClickEvents(gridCellsLine2, 'line6', 1);
    bindLineClickEvents(gridCellsLine3, 'line16', 2);

    document.getElementById('btn-clear').addEventListener('click', clearActiveChannelPattern);
    document.getElementById('btn-play').addEventListener('click', togglePlayback);
    document.querySelector('.rect-box.large').addEventListener('click', togglePlayback); 

    document.getElementById('btn-tap').addEventListener('mousedown', handleTapTempo);

    const plusBtn = document.getElementById('btn-plus');
    plusBtn.addEventListener('mousedown', () => startChangingTempo(1));
    plusBtn.addEventListener('mouseup', stopChangingTempo);
    plusBtn.addEventListener('mouseleave', stopChangingTempo);

    const minusBtn = document.getElementById('btn-minus');
    minusBtn.addEventListener('mousedown', () => startChangingTempo(-1));
    minusBtn.addEventListener('mouseup', stopChangingTempo);
    minusBtn.addEventListener('mouseleave', stopChangingTempo);
}

// 메인 초기 구동 시점
window.addEventListener('DOMContentLoaded', () => {
    initData();
    setupEventListeners();
    selectChannel(0);
    updateTempoDisplay(tempo); 
    updateTimeSignatureUI(); // 초기 4/4 세팅 및 골딩 렌더링 동기화
});

// 이미지 맵 데이터 로더 및 핸들러
document.addEventListener("DOMContentLoaded", () => {
    const imageMap = { 'click01': 'img/click.png', 'click02': 'img/click.png' };
    circleContainers.forEach(container => {
        const select = container.querySelector("select");
        const circleBox = container.querySelector(".circle-box");

        if (select && circleBox) {
            const updateCircleImage = () => {
                const selectedValue = select.value;
                const imageUrl = imageMap[selectedValue];
                circleBox.style.setProperty('--bg-img', imageUrl ? `url('${imageUrl}')` : 'none');
            };
            select.addEventListener("change", updateCircleImage);
            updateCircleImage();
        }
    });
});