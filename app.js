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

// 타이밍 엔진 변수들 부근에 추가
let animationFrameId = null; 
const progressBar = document.getElementById('beat-progress-bar');

const circleContainers = document.querySelectorAll('.circle-container');

// progress-line을 제외하고 순수한 패턴 그리드 라인들만 차례대로 선택합니다.
const actualGridLines = document.querySelectorAll('.grid-line:not(.progress-line)');
const gridCellsLine1 = actualGridLines[0].querySelectorAll('.grid-cell'); // 32분음표 라인 𝅘𝅥𝅰(8)
const gridCellsLine2 = actualGridLines[1].querySelectorAll('.grid-cell'); // 6연음 라인 𝅘𝅥𝅯(6)
const gridCellsLine3 = actualGridLines[2].querySelectorAll('.grid-cell'); // 16분음표 라인 𝅘𝅥𝅯(4)
// 변경 포인트: const였던 tempo를 변경 가능한 let으로 수정하고 DOM 요소를 바인딩합니다.
const tempoDisplay = document.querySelector('.rect-box.large');
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
    tempo = Math.max(30, Math.min(newTempo, 300)); // 최소 30 ~ 최대 300 제한 보정
    tempoDisplay.textContent = String(tempo).padStart(3, '0');
}


// =========================================================================
// [신규 기능 코어 구현 함수들]
// =========================================================================

// 1. CLEAR 기능: 현재 선택된 채널의 시트만 0으로 초기화
function clearActiveChannelPattern() {
    const currentPattern = CHANNELS_DATA[activeChannelIndex].pattern;
    currentPattern.line32.fill(0);
    currentPattern.line6.fill(0);
    currentPattern.line16.fill(0);
    
    // UI 그리드판 즉시 새로고침
    renderLineUI(gridCellsLine1, currentPattern.line32);
    renderLineUI(gridCellsLine2, currentPattern.line6);
    renderLineUI(gridCellsLine3, currentPattern.line16);
    console.log(`${activeChannelIndex + 1}번째 트랙의 패턴 기록이 삭제되었습니다.`);
}

// 2. TAP TEMPO 엔진 연산
function handleTapTempo() {
    initAudio();
    const now = performance.now();
    tapTimes.push(now);

    // 최근 4회 간격만 유지하여 정밀도 유지 (과거 기록은 자동 Shift 시켜 제거)
    if (tapTimes.length > 4) {
        tapTimes.shift();
    }

    if (tapTimes.length >= 2) {
        let totalIntervals = 0;
        for (let i = 1; i < tapTimes.length; i++) {
            totalIntervals += (tapTimes[i] - tapTimes[i - 1]);
        }
        const avgInterval = totalIntervals / (tapTimes.length - 1); // ms 단위 간격 평균
        const calculatedTempo = Math.round(60000 / avgInterval);   // BPM 변환
        
        updateTempoDisplay(calculatedTempo);
    }
    
    // 3초 이상 입력을 안 하면 타이밍 체인 리셋
    clearTimeout(window.tapResetTimeout);
    window.tapResetTimeout = setTimeout(() => { tapTimes = []; }, 3000);
}

// 3. 연속 증감(Long Press) 매커니즘 구현 함수
function startChangingTempo(amount) {
    // 일단 1회 즉시 증감
    updateTempoDisplay(tempo + amount);
    
    // 400ms 동안 계속 누르고 있다면 그때부터 50ms 주기로 폭발적으로 가속 증가
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

// =========================================================================
// 2. 오디오 컨텍스트 및 사운드 버퍼 로더
// =========================================================================
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
}

async function loadSound(soundName) {
	if (soundName === 'empty') return;
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
	if (soundName === 'empty') return;
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

function selectChannel(index) {
    activeChannelIndex = index;
    
    circleContainers.forEach((container, idx) => {
        const circle = container.querySelector('.circle-box');
        if (idx === index) {
            // 선택된 박스에 고정 효과(selected) 클래스 추가
            circle.classList.add('selected');
        } else {
            // 나머지 박스들은 고정 효과 클래스 제거 -> 원래 메탈릭 실버로 복귀
            circle.classList.remove('selected');
        }
    });

    const data = CHANNELS_DATA[activeChannelIndex].pattern;
    renderLineUI(gridCellsLine1, data.line32);
    renderLineUI(gridCellsLine2, data.line6);
    renderLineUI(gridCellsLine3, data.line16);
}

function renderLineUI(domCells, dataArray) {
    domCells.forEach((cell, idx) => {
        const state = dataArray[idx];
        if (state === 0) {
            cell.style.backgroundColor = 'darkkhaki'; // 기본 회색
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
    currentBeat = (currentBeat + 1) % 96; 
}

function scheduleNextNotes(tick, time) {
	// ✨ [신규 추가] 정박(4분음표 = 24틱 마다) 자바스크립트로 그림자 불빛 켜기
	    if (tick % 24 === 0) {
	        const tapBtn = document.getElementById('btn-tap');
	        if (tapBtn) {
	            // 박자 순간에 클래스 주입
	            tapBtn.classList.add('tap-blink');
	            
	            // 150ms(0.15초) 뒤에 자연스럽게 불빛 끄기
	            setTimeout(() => {
	                tapBtn.classList.remove('tap-blink');
	            }, 150);
	        }
	    }	
	
	
	
	
	
    CHANNELS_DATA.forEach(channel => {
        if (tick % 3 === 0) {
            const step32 = tick / 3;
            const state = channel.pattern.line32[step32];
            if (state > 0) playSample(channel.sound, time, channel.volume, state === 2);
        }
        
        if (tick % 4 === 0) {
            const step6 = tick / 4;
            const state = channel.pattern.line6[step6];
            if (state > 0) playSample(channel.sound, time, channel.volume, state === 2);
        }
        
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
        
        // 재생 시 프로그레스 바 그리기 루프 시작
		// 재생 시 프로그레스 바 그리기 루프 내부 찾기
		function updateProgressBarLoop() {
		    if (!isPlaying) return;
		    
		    const progressPercent = (currentBeat / 96) * 100;
		    if (progressBar) {
		        progressBar.style.width = `${progressPercent}%`;
		        
		        // 🛠️ 여기에 패턴 스타일 추가 (회색 세로줄 예시)
		        progressBar.style.background = `repeating-linear-gradient(
					90deg,
					    rgba(51, 255, 51, 0.5),   /* 🟢 형광색 (투명도 30% 적용) */
					    rgba(51, 255, 51, 0.5) 5px,
					    transparent 5px,          /* 선이 끝나는 5px 지점부터 바로 투명 시작 */
					    transparent 7px          /* 총 11px 주기로 반복 (선 5px + 공백 6px) */
		        )`;
		    }
		    
		    animationFrameId = requestAnimationFrame(updateProgressBarLoop);
		}
        animationFrameId = requestAnimationFrame(updateProgressBarLoop);
        
        console.log("드럼머신이 재생됩니다. (템포: " + tempo + ")");
    } else {
        isPlaying = false;
        clearTimeout(timeoutId);
        
        // 정지 시 루프를 취소하고 바를 0%로 초기화
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        if (progressBar) {
            progressBar.style.width = '0%';
        }
        
        console.log("드럼머신이 일시 정지되었습니다.");
    }
}

// =========================================================================
// 5. 이벤트 리스너 바인딩 (인터랙션 핸들러)
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

    // B. 하단 그리드 클릭 시 3단계 상태 토글 이벤트 핸들러
    function bindLineClickEvents(domCells, arrayKey) {
        domCells.forEach((cell, idx) => {
            cell.addEventListener('click', () => {
                initAudio();
                const currentPatternData = CHANNELS_DATA[activeChannelIndex].pattern[arrayKey];
                
                let nextState = (currentPatternData[idx] + 1) % 3;
                currentPatternData[idx] = nextState;
                
                // ✨ 따옴표 오타 수정 완료된 구간 ('white')
                if (nextState === 0) {
                    cell.style.backgroundColor = 'darkkhaki'; 
                } else if (nextState === 1) {
                    cell.style.backgroundColor = '#ffa500'; 
                } else if (nextState === 2) {
                    cell.style.backgroundColor = '#ff4d4d'; 
                }
            });
        });
    }

    bindLineClickEvents(gridCellsLine1, 'line32');
    bindLineClickEvents(gridCellsLine2, 'line6');
    bindLineClickEvents(gridCellsLine3, 'line16');

    // [버튼 인터랙션 이벤트 바인딩 리스트]
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
});

document.addEventListener("DOMContentLoaded", () => {
    const circleContainers = document.querySelectorAll(".circle-container");

    const imageMap = {
		'click01': 'img/click.png',
		'click02': 'img/click.png',
		'click03': 'img/click.png',
		'click04': 'img/click.png',
		'click05': 'img/click.png',
		'click06': 'img/click.png',
		'click07': 'img/click.png',
		'click08': 'img/click.png',
		'click09': 'img/click.png',
		'click10': 'img/click.png',
		'hat_close': 'img/hat_close.png',     
		'hat_open': 'img/hat_open.png',    		
		'crash': 'img/crash.png', 
		'ride': 'img/ride.png',
		'kick': 'img/kick.png',
		'snare': 'img/snare.png',  	 
        'tom01': 'img/tom.png',
        'tom02': 'img/tom.png',
        'tom03': 'img/tom.png',
        'tom04': 'img/tom.png',
        'tom05': 'img/tom.png',
        'tom06': 'img/tom.png',
		'tom07': 'img/tom.png',
		'tom08': 'img/tom.png',
		'tom09': 'img/tom.png',
		'tom10': 'img/tom.png',
		'clap': 'img/clap.png',       
		'shaker': 'img/shaker.png',

    };


	
	
    circleContainers.forEach(container => {
        const select = container.querySelector("select");
        const circleBox = container.querySelector(".circle-box");

        if (select && circleBox) {
            const updateCircleImage = () => {
                const selectedValue = select.value;
                const imageUrl = imageMap[selectedValue];

                if (imageUrl) {
                    circleBox.style.setProperty('--bg-img', `url('${imageUrl}')`);
                } else {
                    circleBox.style.setProperty('--bg-img', 'none');
                }
            };

            select.addEventListener("change", updateCircleImage);
            updateCircleImage();
        }
    });
});





