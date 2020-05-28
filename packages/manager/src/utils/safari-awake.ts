import { detect } from "detect-browser";

const AUDIBLE = false;
let audioCtx: AudioContext;
let init = false;

/**
 * Timers (such as setTimeout) of Safari is not punctual when the screen is invisible.
 * As a workaround, we keep playing silent sound using WebAudio.  This keeps timers
 * relatively accurate.
 */
export function keepAwakeSafari(): void {
    if (init) {
        return;
    }
    init = true;
    const browser = detect();
    if (!browser || browser.name !== "safari") {
        console.log("keepAwakeSafari: not on Safari!");
        return;
    }
    console.log("keepAwakeSafari: on Safari!");
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AC();
    play();
}

function play(): void {
    // maybe SOUND_LENGTH should be > TIMER_INTERVAL to make sure that setTimeout is called
    // while playing sound.
    const SOUND_DURATION = 1500;
    const TIMER_INTERVAL = 1000;
    const frameCount = audioCtx.sampleRate * (SOUND_DURATION / 1000.0);
    const audioBuffer = audioCtx.createBuffer(
        1,
        frameCount,
        audioCtx.sampleRate
    );
    const buf = audioBuffer.getChannelData(0);
    for (let i = 0; i < frameCount; i++) {
        buf[i] = AUDIBLE ? Math.random() * 2.0 - 1 : 0;
    }
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    source.start();
    const start = Date.now();
    setTimeout(() => {
        console.log(
            "awakeSafari: delay=",
            Date.now() - (start + TIMER_INTERVAL)
        );
        play();
    }, TIMER_INTERVAL);
}
