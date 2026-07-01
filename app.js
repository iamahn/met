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
        timeSignature = timeSignature >= 4 ? 1 : timeSignature + 1;
        updateTimeSignatureUI(); 
    });
}

let maxTicks = 96;     // 박자수에 따른 최대 tick 제한 (1박당 24 tick * timeSignature)

let animationFrameId = null; 
const progressBar = document.getElementById('beat-progress-bar');
const circleContainers = document.querySelectorAll('.circle-container');

// progress-line을 제외하고 순수한 패턴 그리드 라인들만 차례대로 선택합니다.
const actualGridLines = document.querySelectorAll('.grid-line:not(.progress-line)');
const gridCellsLine1 = actualGridLines[0].querySelectorAll('.grid-cell'); 
const gridCellsLine2 = actualGridLines[1].querySelectorAll('.grid-cell'); 
const gridCellsLine3 = actualGridLines[2].querySelectorAll('.grid-cell'); 

const tempoDisplay = document.getElementById('bpm-value');
let tempo = parseInt(tempoDisplay.textContent) || 60;

let activeChannelIndex = 0;

// Tap Tempo 측정을 위한 배열 기록 장치
let tapTimes = [];

// 연속 증감(Long-press) 처리를 위한 타이머 변수
let tempoIntervalId = null;
let tempoTimeoutId = null;

// ⚡ [브라우저 엔진 전용 변수]
let selectedSavedPatternId = null; 

// 데이터 초기화
function initData() {
    CHANNELS_DATA.length = 0; // 배열 비우기 (불러오기 시 충돌 방지)
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

function clearActiveChannelPattern() {
    const currentPattern = CHANNELS_DATA[activeChannelIndex].pattern;
    currentPattern.line32.fill(0);
    currentPattern.line6.fill(0);
    currentPattern.line16.fill(0);
    updateTimeSignatureUI();
}

function handleTapTempo() {
    initAudio();
    const now = performance.now();
    tapTimes.push(now);

    if (tapTimes.length > 4) tapTimes.shift();

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

// 동적 박자 변경 및 그리드 렌더링 동기화 엔진
function updateTimeSignatureUI() {
    maxTicks = timeSignature * 24;
    currentBeat = currentBeat % maxTicks;

    const sigValueDisplay = document.getElementById('sig-value');
    if (sigValueDisplay) {
        sigValueDisplay.textContent = `${timeSignature}/4`;
    }

    actualGridLines.forEach((line, lineIdx) => {
        const groups = line.querySelectorAll('.grid-group');
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
                    
                    if (lineIdx === 0) stateVal = currentPattern.line32[globalCellIdx];
                    else if (lineIdx === 1) stateVal = currentPattern.line6[globalCellIdx];
                    else if (lineIdx === 2) stateVal = currentPattern.line16[globalCellIdx];

                    if (stateVal === 0) cell.style.backgroundColor = 'darkkhaki';
                    else if (stateVal === 1) cell.style.backgroundColor = '#ffa500';
                    else if (stateVal === 2) cell.style.backgroundColor = '#ff4d4d';

                    globalCellIdx++; 
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

    // 프로그레스 바 컨테이너 맞춤
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

function cycleTimeSignature() {
    timeSignature = (timeSignature % 4) + 1; 
    updateTimeSignatureUI();
}

// =========================================================================
// 오디오 컨텍스트 및 사운드 버퍼 로더
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
        if (!audioBuffers['tick']) loadSound('tick'); 
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
                console.warn(`${fileName}.wav 로드 실패.`, err);
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
        console.warn(`${soundName}.wav 로드 실패.`, err);
    }
}

function playSample(soundName, time, volume, isAccent) {
    if (soundName === 'empty') return;
    if (!audioCtx) return;
    
    // 악센트 다이내믹 극대화
    const finalVolume = isAccent ? (volume * 2.5) : (volume * 0.7);
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(Math.min(finalVolume, 2.0), time);
    gainNode.connect(audioCtx.destination);

    if (audioBuffers[soundName]) {
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffers[soundName];
        source.connect(gainNode);
        source.start(time);
    } else {
        const osc = audioCtx.createOscillator();
        osc.type = isAccent ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(isAccent ? 250 : 120, time);
        osc.connect(gainNode);
        osc.start(time);
        osc.stop(time + 0.1);
    }
}

function selectChannel(index) {
    activeChannelIndex = index;
    circleContainers.forEach((container, idx) => {
        const circle = container.querySelector('.circle-box');
        if (idx === index) circle.classList.add('selected');
        else circle.classList.remove('selected');
    });
    updateTimeSignatureUI();
}

// =========================================================================
// 타이밍 룰 및 스케줄러 알고리즘
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
                soundToPlay = `${counts[currentBeatIndex] || 'one'}${num}`; 
            } else {
                soundToPlay = 'tick'; 
            }
        }

        if (tick % 3 === 0) {
            const step32 = tick / 3;
            const state = channel.pattern.line32[step32];
            if (state > 0 && step32 < (timeSignature * 8)) {
                playSample(soundToPlay, time, channel.volume, state === 2);
            }
        }
        if (tick % 4 === 0) {
            const step6 = tick / 4;
            const state = channel.pattern.line6[step6];
            if (state > 0 && step6 < (timeSignature * 6)) {
                playSample(soundToPlay, time, channel.volume, state === 2);
            }
        }
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
            if (progressBar) progressBar.style.width = `${progressPercent}%`;
            animationFrameId = requestAnimationFrame(updateProgressBarLoop);
        }
        animationFrameId = requestAnimationFrame(updateProgressBarLoop);
    } else {
        isPlaying = false;
        clearTimeout(timeoutId);
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (progressBar) progressBar.style.width = '0%';
    }
}

// =========================================================================
// ⚡ [신규 추가] 패턴 브라우저 영구 로컬스토리지 제어 코어 엔진
// =========================================================================

// 1) 로컬스토리지에서 목록 추출 및 렌더링
function renderBrowserList() {
    const listContainer = document.getElementById('browser-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    const savedPatterns = JSON.parse(localStorage.getItem('metronome_patterns') || '[]');

    savedPatterns.forEach(pattern => {
        const item = document.createElement('div');
        item.className = 'pattern-item';
        if (selectedSavedPatternId === pattern.id) {
            item.classList.add('selected');
        }

        // 인풋 상자를 내장하여 클릭 시 텍스트 즉시 직접 수정 연동
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pattern-name-input';
        input.value = pattern.name;

        // 이름 수정 완료 시 동기화
        input.addEventListener('change', (e) => {
            renamePattern(pattern.id, e.target.value);
        });

        // 슬롯 선택 이벤트
        item.addEventListener('click', (e) => {
            if (e.target === input) return; // 글씨 지울 때는 선택 해제 방지
            selectedSavedPatternId = pattern.id;
            renderBrowserList();
        });

        item.appendChild(input);
        listContainer.appendChild(item);
    });
}

// 2) 신규 세이브 패턴 생성 (요청하신 규격 포맷 자동 적용)
function saveCurrentPattern() {
    const savedPatterns = JSON.parse(localStorage.getItem('metronome_patterns') || '[]');
    
    // 번호 자동 계산 (Pattern 001, 002 형식)
    const nextNum = String(savedPatterns.length + 1).padStart(3, '0');
    const defaultName = `pattern ${nextNum} ${timeSignature}/4 ${tempo}`;

    const newPattern = {
        id: Date.now(), // 고유 ID 식별자 생성
        name: defaultName,
        tempo: tempo,
        timeSignature: timeSignature,
        channelsData: CHANNELS_DATA.map(ch => ({
            id: ch.id,
            sound: ch.sound,
            volume: ch.volume,
            pattern: JSON.parse(JSON.stringify(ch.pattern)) // 딥 카피 백업
        }))
    };

    savedPatterns.push(newPattern);
    localStorage.setItem('metronome_patterns', JSON.stringify(savedPatterns));
    selectedSavedPatternId = newPattern.id; // 신규 생성된 슬롯 자동 선택 고정
    renderBrowserList();
    console.log("패턴 브라우저 저장 완료:", defaultName);
}

// 3) 선택된 패턴 드럼머신 보드로 로드
function loadSelectedPattern() {
    if (!selectedSavedPatternId) {
        alert("브라우저 목록에서 불러올 패턴 슬롯을 선택해 주세요!");
        return;
    }

    const savedPatterns = JSON.parse(localStorage.getItem('metronome_patterns') || '[]');
    const target = savedPatterns.find(p => p.id === selectedSavedPatternId);

    if (!target) return;

    // 1. 박자와 템포 기어 변동 및 화면 동기화
    tempo = target.tempo;
    timeSignature = target.timeSignature;
    updateTempoDisplay(tempo);

    // 2. 물리 채널 7개 내부 정보 복원
    target.channelsData.forEach((savedCh, idx) => {
        if (CHANNELS_DATA[idx]) {
            CHANNELS_DATA[idx].sound = savedCh.sound;
            CHANNELS_DATA[idx].volume = savedCh.volume;
            CHANNELS_DATA[idx].pattern = savedCh.pattern;

            // 실제 웹페이지 상의 셀렉트박스와 노브 슬라이더 UI 위치 보정
            const container = circleContainers[idx];
            if (container) {
                container.querySelector('.dropdown-menu').value = savedCh.sound;
                container.querySelector('.volume-slider').value = Math.round(savedCh.volume * 100);
            }
            loadSound(savedCh.sound); // 음원 실시간 가동 버퍼 예약
        }
    });

    // 3. 전광판 및 격자판 통합 새로고침
    updateTimeSignatureUI();

    // 4. 원형 패드 이미지 싱크 강제 리프레시 발생시키기
    window.dispatchEvent(new Event('refreshCircleImages'));
    console.log("패턴 브라우저 정상 로드 완료:", target.name);
}

// 4) 삭제 기능
function deleteSelectedPattern() {
    if (!selectedSavedPatternId) {
        alert("삭제할 패턴 슬롯을 브라우저 목록에서 골라주세요!");
        return;
    }

    let savedPatterns = JSON.parse(localStorage.getItem('metronome_patterns') || '[]');
    savedPatterns = savedPatterns.filter(p => p.id !== selectedSavedPatternId);
    localStorage.setItem('metronome_patterns', JSON.stringify(savedPatterns));
    
    selectedSavedPatternId = null;
    renderBrowserList();
}

// 5) 브라우저 텍스트 직접 입력 수정 핸들러
function renamePattern(id, newName) {
    const savedPatterns = JSON.parse(localStorage.getItem('metronome_patterns') || '[]');
    const target = savedPatterns.find(p => p.id === id);
    if (target) {
        target.name = newName;
        localStorage.setItem('metronome_patterns', JSON.stringify(savedPatterns));
    }
}

// =========================================================================
// 이벤트 리스너 바인딩 (인터랙션 핸들러)
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
            window.dispatchEvent(new Event('refreshCircleImages')); // 이미지 즉시 연동
        });

        const slider = container.querySelector('.volume-slider');
        slider.addEventListener('input', (e) => {
            CHANNELS_DATA[index].volume = parseInt(e.target.value) / 100;
        });
    });

    function bindLineClickEvents(domCells, arrayKey, lineIdx) {
        domCells.forEach((cell, idx) => {
            cell.addEventListener('click', () => {
                initAudio();
                const groupIdx = Math.floor(idx / (domCells.length / 4));
                if (groupIdx >= timeSignature) return;

                const currentPatternData = CHANNELS_DATA[activeChannelIndex].pattern[arrayKey];
                let nextState = (currentPatternData[idx] + 1) % 3;
                currentPatternData[idx] = nextState;
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

    // ⚡ [브라우저 전용 마우스 버튼 리스너 바인딩]
    document.getElementById('browser-save').addEventListener('click', saveCurrentPattern);
    document.getElementById('browser-load').addEventListener('click', loadSelectedPattern);
    document.getElementById('browser-del').addEventListener('click', deleteSelectedPattern);
}

// =========================================================================
// 메인 초기 구동 및 이미지 맵 바인딩 핸들러 (수정본)
// =========================================================================
window.addEventListener('DOMContentLoaded', async () => { // ⚡ async 추가
    initData();
    setupEventListeners();
    selectChannel(0);
    updateTempoDisplay(tempo); 
    updateTimeSignatureUI(); 
    renderBrowserList(); 

    // ⚡ [버그 수정 핵심] 초기 7개 채널에 설정된 기본 사운드 파일들을 미리 버퍼에 로드합니다.
    CHANNELS_DATA.forEach(channel => {
        if (channel.sound && channel.sound !== 'empty') {
            loadSound(channel.sound);
        }
    });

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

    const updateAllCircleImages = () => {
        circleContainers.forEach(container => {
            const select = container.querySelector("select");
            const circleBox = container.querySelector(".circle-box");
            if (select && circleBox) {
                const selectedValue = select.value;
                const imageUrl = imageMap[selectedValue];
                circleBox.style.setProperty('--bg-img', imageUrl ? `url('${imageUrl}')` : 'none');
            }
        });
    };

    window.addEventListener('refreshCircleImages', updateAllCircleImages);
    updateAllCircleImages();
});