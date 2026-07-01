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
function updateTempoDisplay(newTempo) {
    tempo = Math.max(30, Math.min(newTempo, 300));
    
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
    maxTicks = timeSignature * 24;
    currentBeat = currentBeat % maxTicks;

    const sigValueDisplay = document.getElementById('sig-value');
    if (sigValueDisplay) {
        sigValueDisplay.textContent = `${timeSignature}/4`;
    }

    // 그리드 라인 별 4개 그룹들의 활성화/비활성화 처리
    actualGridLines.forEach((line, lineIdx) => {
        const groups = line.querySelectorAll('.grid-group');
        
        // 이 라인 전체에서 현재 셀이 몇 번째 일련번호인지 추적하기 위한 변수
        let globalCellIdx = 0; 

        groups.forEach((group, gIdx) => {
            const isActive = gIdx < timeSignature;
            const cells = group.querySelectorAll('.grid-cell');
            
            if (isActive) {
                group.style.opacity = "1";
                cells.forEach((cell) => {
                    cell.style.pointerEvents = 'auto';
                    cell.style.boxShadow = 'inset 0 1px 2px rgba(255, 255, 255, 0.2), 0 1px 2px rgba(0, 0, 0, 0.1)';
                    cell.style.border = '';
                    
                    const currentPattern = CHANNELS_DATA[activeChannelIndex].pattern;
                    let stateVal = 0;
                    
                    // 🔥 [버그 전면 수정] 에러를 내던 변수를 지우고 정확한 1차원 배열 인덱스를 연결했습니다.
                    if (lineIdx === 0) stateVal = currentPattern.line32[globalCellIdx];
                    else if (lineIdx === 1) stateVal = currentPattern.line6[globalCellIdx];
                    else if (lineIdx === 2) stateVal = currentPattern.line16[globalCellIdx];

                    // 💡 정석 순서 매칭: 0(다크카키) -> 1(오렌지) -> 2(레드)
                    if (stateVal === 0) cell.style.backgroundColor = 'darkkhaki';
                    else if (stateVal === 1) cell.style.backgroundColor = '#ffa500';
                    else if (stateVal === 2) cell.style.backgroundColor = '#ff4d4d';

                    globalCellIdx++; // 다음 셀 검사를 위해 인덱스 증가
                });
            } else {
                cells.forEach(cell => {
                    cell.style.pointerEvents = 'none';
                    cell.style.backgroundColor = 'gold';
                    cell.style.boxShadow = 'none';
                    cell.style.border = 'none';
                    globalCellIdx++;
                });
            }
        });
    });

    // 프로그레스 바 컨테이너 너비 맞춤
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
    timeSignature = (timeSignature % 4) + 1; 
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
    initAudio(); 
    
    if (soundName.startsWith('human')) {
        if (!audioBuffers['tick']) {
            loadSound('tick'); 
        }
        
        const num = soundName.replace('human', ''); 
        const counts = ['one', 'two', 'three', 'four'];
        
        for (const count of counts) {
            const fileName = `${count}${num}`; 
            if (audioBuffers[fileName]) continue; 
            
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

    if (audioBuffers[soundName]) return;
    const filePath = `./sound/${soundName}.wav`;
    try {
        const response = await fetch(filePath);
        if (!response.ok) throw new Error(`파일 분실: ${filePath}`);
        const arrayBuffer = await response.arrayBuffer();
        audioBuffers[soundName] = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (err) {
        console.warn(`${soundName}.wav 로드 실패. 가상 오실레이터 비프로 대체됩니다.`, err);
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
    currentBeat = (currentBeat + 1) % maxTicks; 
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
        
        if (soundToPlay.startsWith('human')) {
            const num = soundToPlay.replace('human', ''); 
            const isExactBeat = (tick % 24 === 0); 
            
            if (isExactBeat) {
                const currentBeatIndex = Math.floor(tick / 24); 
                const counts = ['one', 'two', 'three', 'four'];
                const targetCount = counts[currentBeatIndex] || 'one';
                
                soundToPlay = `${targetCount}${num}`; 
            } else {
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
                
                const groupIdx = Math.floor(idx / (domCells.length / 4));
                if (groupIdx >= timeSignature) return;

                const currentPatternData = CHANNELS_DATA[activeChannelIndex].pattern[arrayKey];
                
                // 1) 순수 데이터 상태 순환 (0 -> 1 -> 2 -> 0)
                let nextState = (currentPatternData[idx] + 1) % 3;
                currentPatternData[idx] = nextState;
                
                // 2) UI 통합 동기화 호출
                updateTimeSignatureUI();
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

// 💡 [통합] 메인 초기 구동 시점 및 이미지 맵 바인딩 핸들러
window.addEventListener('DOMContentLoaded', () => {
    initData();
    setupEventListeners();
    selectChannel(0);
    updateTempoDisplay(tempo); 
    updateTimeSignatureUI(); 

    const imageMap = { 
        'click01': 'img/click.png', 'click02': 'img/click.png', 'click03': 'img/click.png',
        'click04': 'img/click.png', 'click05': 'img/click.png', 'click06': 'img/click.png',
        'click07': 'img/click.png', 'click08': 'img/click.png', 'click09': 'img/click.png',
        'click10': 'img/click.png', 'hat_close': 'img/hat_close.png', 'hat_open': 'img/hat_open.png',           
        'crash': 'img/crash.png', 'ride': 'img/ride.png', 'kick': 'img/kick.png', 'snare': 'img/snare.png',      
        'tom01': 'img/tom.png', 'tom02': 'img/tom.png', 'tom03': 'img/tom.png', 'tom04': 'img/tom.png',
        'tom05': 'img/tom.png', 'tom06': 'img/tom.png', 'tom07': 'img/tom.png', 'tom08': 'img/tom.png',
        'tom09': 'img/tom.png', 'tom10': 'img/tom.png', 'clap': 'img/clap.png', 'shaker': 'img/shaker.png',
        'human1': 'img/human1.png', 'human2': 'img/human2.png', 'human3': 'img/human3.png'
    };

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