import { PianoAudioEngine } from './audio.js';

const STORAGE_KEY = 'piano_studio_config_v1';

const DEFAULT_CONFIG = {
  instrument: 'grand',
  volume: 85,
  reverb: 35,
  sustain: 180,
  brightness: 60,
  keysMode: 'auto',
  portraitMode: 'single',
  baseOctave: 4,
  tuning: 440,
  theme: 'classic',
  glissando: true,
  haptics: true,
  dynamicVelocity: true,
  showLabels: false
};

const NOTE_NAMES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const WHITE_SEMITONES = new Set([0, 2, 4, 5, 7, 9, 11]);

// Acoustic grand piano black-key horizontal alignment relative to the crack between white keys
const BLACK_SEAM_OFFSET = {
  1: 0.57,  // C# slightly left of C|D seam
  3: 0.43,  // D# slightly right of D|E seam
  6: 0.57,  // F# slightly left of F|G seam
  8: 0.50,  // G# centered on G|A seam
  10: 0.43  // A# slightly right of A|B seam
};

// Computer keyboard mapping (lower row + upper row)
const KEYBOARD_MAP = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5,
  KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
  Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23,
  KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // Ignore storage quota errors in private browsing
  }
}

const config = loadConfig();
const audio = new PianoAudioEngine(config);

const pianoShell = document.getElementById('piano-app');
const pianoCase = document.getElementById('piano-case');
const pianoRail = document.getElementById('piano-rail');
const stage = document.getElementById('keyboards-stage');
const configDialog = document.getElementById('config-dialog');
const configForm = document.getElementById('config-form');
const btnResetConfig = document.getElementById('btn-reset-config');

// Track active notes by input source so multi-touch chords & overlapping keys work cleanly
const pointerNotes = new Map(); // pointerId -> midi
const keyboardNotes = new Map(); // code -> midi
const midiElements = new Map(); // midi -> Set<HTMLElement>

function getEffectiveStageDimensions() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const isPortrait = vh > vw;

  if (isPortrait && config.portraitMode === 'rotated') {
    return { width: vh, height: vw, isPortrait, isDual: false };
  }

  if (isPortrait && config.portraitMode === 'dual') {
    return { width: vw, height: vh, isPortrait, isDual: true };
  }

  return { width: vw, height: vh, isPortrait, isDual: false };
}

function resolveWhiteKeyCount(effectiveWidth) {
  if (config.keysMode !== 'auto') {
    return Number(config.keysMode) || 15;
  }
  if (effectiveWidth < 500) return 8;    // 1 Octave (C to C) - wide ergonomic keys on mobile portrait
  if (effectiveWidth < 740) return 11;   // 1.5 Octaves (C to F)
  if (effectiveWidth < 1020) return 15;  // 2 Octaves (C to C) - mobile landscape & tablet portrait
  if (effectiveWidth < 1420) return 22;  // 3 Octaves (C to C) - tablet landscape & laptop
  return 29;                             // 4 Octaves (C to C) - wide desktop
}

function generateDeckNotes(startOctave, targetWhiteKeys) {
  const startMidi = (startOctave + 1) * 12; // C of startOctave
  const notes = [];
  let whiteCount = 0;
  let midi = startMidi;

  while (whiteCount < targetWhiteKeys && midi <= 108) {
    const semitone = midi % 12;
    const isWhite = WHITE_SEMITONES.has(semitone);
    const octave = Math.floor(midi / 12) - 1;
    const name = `${NOTE_NAMES_ES[semitone]}${octave}`;

    notes.push({
      midi,
      semitone,
      octave,
      name,
      isWhite,
      whiteIndex: isWhite ? whiteCount : whiteCount - 1
    });

    if (isWhite) {
      whiteCount++;
    }
    midi++;
  }

  return { notes, whiteCount };
}

function createDeckElement(startOctave, whiteKeyCount) {
  const { notes, whiteCount } = generateDeckNotes(startOctave, whiteKeyCount);
  const deck = document.createElement('div');
  deck.className = 'keyboard-deck';
  deck.style.setProperty('--white-keys', String(whiteCount));

  const whiteContainer = document.createElement('div');
  whiteContainer.className = 'white-keys';

  const blackContainer = document.createElement('div');
  blackContainer.className = 'black-keys';

  const whiteWidthPct = 100 / whiteCount;
  // Slightly wider black keys on smaller key counts for effortless mobile touch accuracy
  const blackWidthRatio = whiteCount <= 11 ? 0.64 : 0.60;
  const blackWidthPct = whiteWidthPct * blackWidthRatio;

  for (const n of notes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.midi = String(n.midi);
    btn.setAttribute('aria-label', n.name);

    const label = document.createElement('span');
    label.className = 'key-label';
    label.textContent = n.semitone === 0 ? n.name : NOTE_NAMES_ES[n.semitone];

    if (n.isWhite) {
      btn.className = 'piano-key white-key';
      btn.appendChild(label);
      whiteContainer.appendChild(btn);
    } else {
      btn.className = 'piano-key black-key';
      const seamPct = (n.whiteIndex + 1) * whiteWidthPct;
      const offsetFactor = BLACK_SEAM_OFFSET[n.semitone] ?? 0.5;
      const leftPct = seamPct - blackWidthPct * offsetFactor;

      btn.style.setProperty('--black-left', `${leftPct.toFixed(4)}%`);
      btn.style.setProperty('--black-width', `${blackWidthPct.toFixed(4)}%`);

      const surface = document.createElement('span');
      surface.className = 'black-key-surface';
      surface.appendChild(label);
      btn.appendChild(surface);
      blackContainer.appendChild(btn);
    }

    if (!midiElements.has(n.midi)) {
      midiElements.set(n.midi, new Set());
    }
    midiElements.get(n.midi).add(btn);
  }

  deck.appendChild(whiteContainer);
  deck.appendChild(blackContainer);
  return deck;
}

function renderPiano() {
  // Release any active notes before rebuilding DOM
  releaseAllNotes();
  midiElements.clear();
  stage.replaceChildren();

  pianoShell.dataset.theme = config.theme;
  pianoShell.dataset.portraitMode = config.portraitMode;
  pianoShell.dataset.labels = String(Boolean(config.showLabels));

  const { width, isDual } = getEffectiveStageDimensions();
  const baseOct = Number(config.baseOctave) || 4;
  pianoCase.style.setProperty('--decks-count', isDual ? '2' : '1');

  if (isDual) {
    // Dual stacked keyboards in portrait: Upper octave on top, Base octave on bottom
    const perRowWhiteKeys = config.keysMode === 'auto' ? 8 : Math.min(15, Number(config.keysMode) || 8);
    const upperDeck = createDeckElement(Math.min(6, baseOct + 1), perRowWhiteKeys);
    const lowerDeck = createDeckElement(baseOct, perRowWhiteKeys);
    stage.appendChild(upperDeck);
    stage.appendChild(lowerDeck);
  } else {
    const whiteKeyCount = resolveWhiteKeyCount(width);
    // Center middle octave naturally when showing 2+ octaves in auto mode
    let startOctave = baseOct;
    if (whiteKeyCount >= 29) {
      startOctave = Math.max(1, baseOct - 2);
    } else if (whiteKeyCount >= 15) {
      startOctave = Math.max(1, baseOct - 1);
    }
    const deck = createDeckElement(startOctave, whiteKeyCount);
    stage.appendChild(deck);
  }
}

/* ==========================================================================
   Note Activation, Multi-Touch & Glissando Engine
   ========================================================================== */

function isMidiHeld(midi) {
  for (const m of pointerNotes.values()) {
    if (m === midi) return true;
  }
  for (const m of keyboardNotes.values()) {
    if (m === midi) return true;
  }
  return false;
}

function updateKeyVisual(midi, active) {
  const els = midiElements.get(midi);
  if (!els) return;
  for (const el of els) {
    el.classList.toggle('is-active', active);
  }
}

function triggerHaptic() {
  if (config.haptics && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(7);
    } catch {
      // Ignore vibration restrictions on unsupported devices
    }
  }
}

function computeTouchVelocity(e, keyEl) {
  if (!config.dynamicVelocity) return 0.82;
  const rect = keyEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return 0.82;

  // Detect whether key is oriented vertically (normal) or horizontally (rotated 90deg in portrait)
  let ratio = 0.75;
  if (rect.height >= rect.width) {
    ratio = (e.clientY - rect.top) / rect.height;
  } else {
    ratio = (rect.right - e.clientX) / rect.width;
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  return 0.42 + clamped * 0.58;
}

function pressNoteFromPointer(pointerId, midi, velocity) {
  const prevMidi = pointerNotes.get(pointerId);
  if (prevMidi === midi) return;

  if (prevMidi !== undefined) {
    pointerNotes.delete(pointerId);
    if (!isMidiHeld(prevMidi)) {
      audio.noteOff(prevMidi);
      updateKeyVisual(prevMidi, false);
    }
  }

  if (midi !== null && midi !== undefined) {
    const alreadyActive = isMidiHeld(midi);
    pointerNotes.set(pointerId, midi);
    audio.noteOn(midi, velocity);
    updateKeyVisual(midi, true);
    if (!alreadyActive) {
      triggerHaptic();
    }
  }
}

function releasePointer(pointerId) {
  const prevMidi = pointerNotes.get(pointerId);
  if (prevMidi === undefined) return;
  pointerNotes.delete(pointerId);
  if (!isMidiHeld(prevMidi)) {
    audio.noteOff(prevMidi);
    updateKeyVisual(prevMidi, false);
  }
}

function releaseAllNotes() {
  for (const midi of new Set([...pointerNotes.values(), ...keyboardNotes.values()])) {
    audio.noteOff(midi);
    updateKeyVisual(midi, false);
  }
  pointerNotes.clear();
  keyboardNotes.clear();
}

function getKeyElementAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('.piano-key') : null;
}

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();

  // Release implicit touch pointer capture so elementFromPoint tracks smooth glissando across keys
  if (e.target && typeof e.target.releasePointerCapture === 'function') {
    try {
      if (e.target.hasPointerCapture(e.pointerId)) {
        e.target.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore if not captured
    }
  }

  const keyEl = e.target.closest('.piano-key') || getKeyElementAtPoint(e.clientX, e.clientY);
  if (!keyEl) return;

  const midi = Number(keyEl.dataset.midi);
  const velocity = computeTouchVelocity(e, keyEl);
  pressNoteFromPointer(e.pointerId, midi, velocity);
});

stage.addEventListener('pointermove', (e) => {
  if (!pointerNotes.has(e.pointerId)) return;
  if (!config.glissando) return;
  e.preventDefault();

  const keyEl = getKeyElementAtPoint(e.clientX, e.clientY);
  if (!keyEl) {
    releasePointer(e.pointerId);
    return;
  }

  const midi = Number(keyEl.dataset.midi);
  if (pointerNotes.get(e.pointerId) !== midi) {
    const velocity = computeTouchVelocity(e, keyEl);
    pressNoteFromPointer(e.pointerId, midi, velocity);
  }
});

window.addEventListener('pointerup', (e) => {
  releasePointer(e.pointerId);
});

window.addEventListener('pointercancel', (e) => {
  releasePointer(e.pointerId);
});

window.addEventListener('blur', () => {
  releaseAllNotes();
});

// Prevent context menu on long-press over the piano on mobile
stage.addEventListener('contextmenu', (e) => e.preventDefault());
pianoRail.addEventListener('contextmenu', (e) => e.preventDefault());

// Subtle gesture: Double-tap on the top piano wooden rail opens #config
let lastRailTap = 0;
pianoRail.addEventListener('pointerdown', (e) => {
  const now = performance.now();
  if (now - lastRailTap < 340) {
    e.preventDefault();
    window.location.hash = '#config';
    lastRailTap = 0;
  } else {
    lastRailTap = now;
  }
});

/* ==========================================================================
   Computer Keyboard & Web MIDI Support
   ========================================================================== */

window.addEventListener('keydown', (e) => {
  if (configDialog.open) return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

  const offset = KEYBOARD_MAP[e.code];
  if (offset === undefined) return;

  const baseMidi = (Number(config.baseOctave) + 1) * 12;
  const midi = baseMidi + offset;
  if (keyboardNotes.has(e.code)) return;

  keyboardNotes.set(e.code, midi);
  audio.noteOn(midi, 0.82);
  updateKeyVisual(midi, true);
});

window.addEventListener('keyup', (e) => {
  const midi = keyboardNotes.get(e.code);
  if (midi === undefined) return;
  keyboardNotes.delete(e.code);
  if (!isMidiHeld(midi)) {
    audio.noteOff(midi);
    updateKeyVisual(midi, false);
  }
});

// Optional Web MIDI API auto-connection for USB/Bluetooth MIDI keyboards
if (typeof navigator.requestMIDIAccess === 'function') {
  navigator.requestMIDIAccess().then((midiAccess) => {
    const attachInputs = () => {
      for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = (msg) => {
          const [status, note, velocity] = msg.data;
          const cmd = status & 0xf0;
          if (cmd === 0x90 && velocity > 0) {
            audio.noteOn(note, velocity / 127);
            updateKeyVisual(note, true);
          } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
            audio.noteOff(note);
            updateKeyVisual(note, false);
          }
        };
      }
    };
    attachInputs();
    midiAccess.onstatechange = attachInputs;
  }).catch(() => {
    // Ignore MIDI permission denial
  });
}

/* ==========================================================================
   #config Route & Dialog Synchronization
   ========================================================================== */

const supportsAccentColor = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('accent-color', '#c99738');

function updateRangeProgressFallback(input) {
  if (supportsAccentColor) return;
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const val = Number(input.value) || 0;
  const pct = ((val - min) / (max - min)) * 100;
  input.style.setProperty('--progress', `${pct}%`);
}

function syncFormFromConfig() {
  const instRadio = configForm.querySelector(`input[name="instrument"][value="${config.instrument}"]`);
  if (instRadio) instRadio.checked = true;

  const themeRadio = configForm.querySelector(`input[name="theme"][value="${config.theme}"]`);
  if (themeRadio) themeRadio.checked = true;

  const volumeInput = document.getElementById('cfg-volume');
  const reverbInput = document.getElementById('cfg-reverb');
  const sustainInput = document.getElementById('cfg-sustain');
  const brightnessInput = document.getElementById('cfg-brightness');

  volumeInput.value = String(config.volume);
  reverbInput.value = String(config.reverb);
  sustainInput.value = String(config.sustain);
  brightnessInput.value = String(config.brightness);

  document.getElementById('out-volume').value = `${config.volume}%`;
  document.getElementById('out-reverb').value = `${config.reverb}%`;
  document.getElementById('out-sustain').value = `${(config.sustain / 100).toFixed(1)} s`;
  document.getElementById('out-brightness').value = `${config.brightness}%`;

  for (const slider of [volumeInput, reverbInput, sustainInput, brightnessInput]) {
    updateRangeProgressFallback(slider);
  }

  document.getElementById('cfg-keys-mode').value = String(config.keysMode);
  document.getElementById('cfg-portrait-mode').value = String(config.portraitMode);
  document.getElementById('cfg-octave').value = String(config.baseOctave);
  document.getElementById('cfg-tuning').value = String(config.tuning);

  document.getElementById('cfg-glissando').checked = Boolean(config.glissando);
  document.getElementById('cfg-haptics').checked = Boolean(config.haptics);
  document.getElementById('cfg-velocity-y').checked = Boolean(config.dynamicVelocity);
  document.getElementById('cfg-labels').checked = Boolean(config.showLabels);
}

function handleFormChange() {
  const formData = new FormData(configForm);
  const prevKeysMode = config.keysMode;
  const prevPortraitMode = config.portraitMode;
  const prevBaseOctave = config.baseOctave;

  config.instrument = formData.get('instrument') || 'grand';
  config.theme = formData.get('theme') || 'classic';
  config.volume = Number(formData.get('volume'));
  config.reverb = Number(formData.get('reverb'));
  config.sustain = Number(formData.get('sustain'));
  config.brightness = Number(formData.get('brightness'));
  config.keysMode = formData.get('keysMode') || 'auto';
  config.portraitMode = formData.get('portraitMode') || 'single';
  config.baseOctave = Number(formData.get('baseOctave')) || 4;
  config.tuning = Number(formData.get('tuning')) || 440;

  config.glissando = document.getElementById('cfg-glissando').checked;
  config.haptics = document.getElementById('cfg-haptics').checked;
  config.dynamicVelocity = document.getElementById('cfg-velocity-y').checked;
  config.showLabels = document.getElementById('cfg-labels').checked;

  document.getElementById('out-volume').value = `${config.volume}%`;
  document.getElementById('out-reverb').value = `${config.reverb}%`;
  document.getElementById('out-sustain').value = `${(config.sustain / 100).toFixed(1)} s`;
  document.getElementById('out-brightness').value = `${config.brightness}%`;

  for (const slider of configForm.querySelectorAll('input[type="range"]')) {
    updateRangeProgressFallback(slider);
  }

  saveConfig(config);
  audio.updateConfig(config);

  pianoShell.dataset.theme = config.theme;
  pianoShell.dataset.portraitMode = config.portraitMode;
  pianoShell.dataset.labels = String(Boolean(config.showLabels));

  if (
    prevKeysMode !== config.keysMode ||
    prevPortraitMode !== config.portraitMode ||
    prevBaseOctave !== config.baseOctave
  ) {
    renderPiano();
  }
}

configForm.addEventListener('input', handleFormChange);
configForm.addEventListener('change', handleFormChange);

btnResetConfig.addEventListener('click', () => {
  Object.assign(config, DEFAULT_CONFIG);
  saveConfig(config);
  syncFormFromConfig();
  audio.updateConfig(config);
  renderPiano();
});

function syncRouteWithDialog() {
  const isConfigRoute = window.location.hash.toLowerCase() === '#config';
  if (isConfigRoute) {
    releaseAllNotes();
    syncFormFromConfig();
    if (!configDialog.open) {
      configDialog.showModal();
    }
  } else if (configDialog.open) {
    configDialog.close();
  }
}

configDialog.addEventListener('close', () => {
  // Reset returnValue per modern-web-guidance dialog best practices
  configDialog.returnValue = '';
  if (window.location.hash.toLowerCase() === '#config') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
});

// Fallback for <dialog closedby="any"> in browsers lacking native closedBy support
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) {
        dialog.close();
      }
    });
  }
}

window.addEventListener('hashchange', syncRouteWithDialog);

// Rebuild responsive key layout when viewport size or orientation changes
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderPiano();
  }, 80);
});

// Initial boot
syncFormFromConfig();
renderPiano();
syncRouteWithDialog();
