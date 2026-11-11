export class PianoAudioEngine {
  constructor(config) {
    this.config = config;
    this.ctx = null;
    this.masterGain = null;
    this.dryGain = null;
    this.wetGain = null;
    this.convolver = null;
    this.compressor = null;
    this.waves = {};
    this.hammerBuffer = null;
    this.activeVoices = new Map();
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -14;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.18;

      this.masterGain = this.ctx.createGain();
      this.dryGain = this.ctx.createGain();
      this.wetGain = this.ctx.createGain();
      this.convolver = this.ctx.createConvolver();

      this.convolver.buffer = this.createReverbImpulse(2.4, 2.8);
      this.hammerBuffer = this.createHammerNoiseBuffer();
      this.buildPeriodicWaves();

      this.dryGain.connect(this.compressor);
      this.convolver.connect(this.wetGain);
      this.wetGain.connect(this.compressor);
      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      this.applySettings();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  updateConfig(newConfig) {
    this.config = newConfig;
    if (this.ctx) {
      this.applySettings();
    }
  }

  applySettings() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const vol = Math.max(0, Math.min(1, this.config.volume / 100));
    const rev = Math.max(0, Math.min(1, this.config.reverb / 100));

    this.masterGain.gain.setTargetAtTime(vol * 0.9, now, 0.015);
    this.dryGain.gain.setTargetAtTime(1 - rev * 0.28, now, 0.015);
    this.wetGain.gain.setTargetAtTime(rev * 0.65, now, 0.015);
  }

  buildPeriodicWaves() {
    // Acoustic Grand Piano harmonic spectrum
    const grandReal = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const grandImag = new Float32Array([
      0, 1.0, 0.52, 0.28, 0.16, 0.09, 0.05, 0.025, 0.012, 0.006, 0.003
    ]);
    this.waves.grand = this.ctx.createPeriodicWave(grandReal, grandImag);

    // Intimate Felt Piano harmonic spectrum (warm fundamental, gentle upper partials)
    const feltReal = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
    const feltImag = new Float32Array([0, 1.0, 0.34, 0.11, 0.03, 0.008, 0.002]);
    this.waves.felt = this.ctx.createPeriodicWave(feltReal, feltImag);

    // Electric Piano (Rhodes body)
    const epReal = new Float32Array([0, 0, 0, 0, 0, 0]);
    const epImag = new Float32Array([0, 1.0, 0.22, 0.08, 0.02, 0.01]);
    this.waves.epiano = this.ctx.createPeriodicWave(epReal, epImag);

    // Harpsichord (bright plucked partials)
    const harpReal = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const harpImag = new Float32Array([
      0, 1.0, 0.85, 0.68, 0.52, 0.38, 0.29, 0.22, 0.15, 0.11, 0.08, 0.05, 0.03
    ]);
    this.waves.harpsichord = this.ctx.createPeriodicWave(harpReal, harpImag);
  }

  createHammerNoiseBuffer() {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * 0.045);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      const env = Math.exp(-i / (sampleRate * 0.007));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    return buffer;
  }

  createReverbImpulse(duration, decay) {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const impulse = this.ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        const white = (Math.random() * 2 - 1) * env;
        // Damped high frequencies in concert hall tail
        lp = lp * 0.68 + white * 0.32;
        data[i] = lp * 0.55;
      }
      // Subtle early reflections
      const reflections = [0.014, 0.027, 0.043, 0.061];
      for (const r of reflections) {
        const idx = Math.floor(r * sampleRate);
        if (idx < length) {
          data[idx] += (ch === 0 ? 0.22 : -0.22) * Math.exp(-r * 6);
        }
      }
    }
    return impulse;
  }

  midiToFreq(midi) {
    const a4 = Number(this.config.tuning) || 440;
    return a4 * Math.pow(2, (midi - 69) / 12);
  }

  noteOn(midi, velocity = 0.8) {
    this.ensureContext();
    if (this.activeVoices.has(midi)) {
      this.stopVoice(this.activeVoices.get(midi), 0.025);
      this.activeVoices.delete(midi);
    }

    const now = this.ctx.currentTime;
    const freq = this.midiToFreq(midi);
    const inst = this.config.instrument || 'grand';
    const brightness = (Number(this.config.brightness) || 60) / 100;
    const vel = Math.max(0.18, Math.min(1, velocity));

    const voiceGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';

    // Stereo panning based on note pitch (-0.45 left for bass, +0.45 right for treble)
    let outputNode = voiceGain;
    if (typeof this.ctx.createStereoPanner === 'function') {
      const panner = this.ctx.createStereoPanner();
      const pan = Math.max(-0.48, Math.min(0.48, (midi - 64) / 42));
      panner.pan.setValueAtTime(pan, now);
      voiceGain.connect(panner);
      outputNode = panner;
    }

    outputNode.connect(this.dryGain);
    outputNode.connect(this.convolver);

    filter.connect(voiceGain);

    const oscs = [];

    // Primary oscillator
    const osc1 = this.ctx.createOscillator();
    osc1.frequency.setValueAtTime(freq, now);

    // Secondary detuned unison string oscillator
    const osc2 = this.ctx.createOscillator();
    const osc2Gain = this.ctx.createGain();
    osc2.frequency.setValueAtTime(freq, now);

    if (inst === 'synth') {
      osc1.type = 'sawtooth';
      osc1.detune.setValueAtTime(-6, now);
      osc2.type = 'triangle';
      osc2.detune.setValueAtTime(6, now);
      osc2Gain.gain.setValueAtTime(0.55, now);
    } else if (inst === 'epiano') {
      osc1.setPeriodicWave(this.waves.epiano);
      // Tine bell overtone (7x harmonic that decays quickly)
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(freq * 7, now);
      osc2Gain.gain.setValueAtTime(0.16 * vel * brightness, now);
      osc2Gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.35);
    } else if (inst === 'felt') {
      osc1.setPeriodicWave(this.waves.felt);
      osc2.setPeriodicWave(this.waves.felt);
      osc2.detune.setValueAtTime(2.5, now);
      osc2Gain.gain.setValueAtTime(0.35, now);
    } else if (inst === 'harpsichord') {
      osc1.setPeriodicWave(this.waves.harpsichord);
      osc2.setPeriodicWave(this.waves.harpsichord);
      osc2.detune.setValueAtTime(4.2, now);
      osc2Gain.gain.setValueAtTime(0.4, now);
    } else {
      // Grand piano
      osc1.setPeriodicWave(this.waves.grand);
      osc2.setPeriodicWave(this.waves.grand);
      // Higher notes on a real piano have 3-string unison with slight detuning
      const detuneCents = midi < 48 ? 1.6 : 3.2;
      osc2.detune.setValueAtTime(detuneCents, now);
      osc2Gain.gain.setValueAtTime(0.42, now);
    }

    osc1.connect(filter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filter);

    osc1.start(now);
    osc2.start(now);
    oscs.push(osc1, osc2);

    // Physical hammer strike transient for acoustic/plucked instruments
    if (inst === 'grand' || inst === 'felt' || inst === 'harpsichord') {
      const hammer = this.ctx.createBufferSource();
      hammer.buffer = this.hammerBuffer;

      const hammerFilter = this.ctx.createBiquadFilter();
      hammerFilter.type = 'bandpass';
      hammerFilter.frequency.setValueAtTime(
        Math.min(8000, freq * (inst === 'felt' ? 2.2 : 4.5)),
        now
      );
      hammerFilter.Q.setValueAtTime(1.2, now);

      const hammerGain = this.ctx.createGain();
      const hammerAmt = inst === 'felt' ? 0.08 : inst === 'harpsichord' ? 0.22 : 0.15;
      hammerGain.gain.setValueAtTime(hammerAmt * vel * (0.5 + brightness), now);

      hammer.connect(hammerFilter);
      hammerFilter.connect(hammerGain);
      hammerGain.connect(voiceGain);
      hammer.start(now);
      oscs.push(hammer);
    }

    // Dynamic filter envelope (bright on hammer strike, mellows as string vibrates)
    const maxCutoff = Math.min(16000, freq * (3.5 + brightness * 10) * (0.65 + vel * 0.55));
    const sustainCutoff = Math.max(260, Math.min(8000, freq * (1.6 + brightness * 2.8)));
    filter.frequency.setValueAtTime(
      inst === 'felt' ? maxCutoff * 0.55 : maxCutoff,
      now
    );
    filter.frequency.exponentialRampToValueAtTime(
      inst === 'felt' ? sustainCutoff * 0.65 : sustainCutoff,
      now + (inst === 'synth' ? 0.6 : 0.32)
    );

    // Natural piano string decay envelope (lower strings resonate longer than upper strings)
    const pitchScale = Math.pow(2, (60 - midi) / 36);
    const naturalDecay = Math.max(1.1, Math.min(6.5, 3.2 * pitchScale));
    const peakGain = 0.28 * Math.pow(vel, 1.25);
    const attackTime = inst === 'felt' ? 0.008 : inst === 'synth' ? 0.018 : 0.003;

    voiceGain.gain.setValueAtTime(0.0001, now);
    voiceGain.gain.linearRampToValueAtTime(peakGain, now + attackTime);

    if (inst === 'synth') {
      voiceGain.gain.setTargetAtTime(peakGain * 0.72, now + attackTime, 0.18);
    } else {
      // Initial fast post-hammer drop followed by long singing string decay
      voiceGain.gain.setTargetAtTime(peakGain * 0.58, now + attackTime, 0.14);
      voiceGain.gain.setTargetAtTime(0.0001, now + attackTime + 0.18, naturalDecay * 0.45);
    }

    const voice = { midi, oscs, voiceGain, outputNode, released: false };
    this.activeVoices.set(midi, voice);
  }

  noteOff(midi) {
    const voice = this.activeVoices.get(midi);
    if (!voice || voice.released) return;
    voice.released = true;
    this.activeVoices.delete(midi);

    const releaseSec = Math.max(0.08, (Number(this.config.sustain) || 180) / 1000);
    this.stopVoice(voice, releaseSec);
  }

  stopVoice(voice, releaseSec) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const gainParam = voice.voiceGain.gain;

    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(Math.max(0.0001, gainParam.value), now);
    gainParam.setTargetAtTime(0.00001, now, releaseSec * 0.25);

    const stopAt = now + releaseSec + 0.08;
    for (const src of voice.oscs) {
      try {
        src.stop(stopAt);
      } catch {
        // Ignore already-stopped buffer sources
      }
    }

    setTimeout(() => {
      try {
        voice.outputNode.disconnect();
      } catch {
        // Ignore already disconnected node
      }
    }, (releaseSec + 0.15) * 1000);
  }
}
